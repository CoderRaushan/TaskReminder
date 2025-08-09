const express = require('express');
const webpush = require('web-push');
const bodyParser = require('body-parser');
const path = require('path');
const mongoose = require('mongoose');
const dotenv=require("dotenv");
dotenv.config();

const app = express();
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));
// MongoDB connection
mongoose.connect(process.env.MONGODB_URI).then(() => console.log("✅ MongoDB connected"))
  .catch(err => console.error("❌ MongoDB connection error:", err));

// Enhanced Models with better indexing
const subscriptionSchema = new mongoose.Schema({
  endpoint: { type: String, required: true, unique: true },
  expirationTime: Date,
  keys: {
    p256dh: { type: String, required: true },
    auth: { type: String, required: true }
  }
}, { timestamps: true });

const notificationSchema = new mongoose.Schema({
  message: { type: String, required: true },
  time: { type: Date, required: true, index: true },
  sent: { type: Boolean, default: false, index: true },
  sentAt: Date,
  attempts: { type: Number, default: 0 }
}, { timestamps: true });

// Compound index for efficient queries
notificationSchema.index({ time: 1, sent: 1 });

const Subscription = mongoose.model('Subscription', subscriptionSchema);
const Notification = mongoose.model('Notification', notificationSchema);

// VAPID Keys
const publicVapidKey = process.env.publicVapidKey;
const privateVapidKey = process.env.privateVapidKey;
webpush.setVapidDetails(`mailto:${process.env.EMAIL}`, publicVapidKey, privateVapidKey);

// Global variable to track if notification job is running
let isJobRunning = false;

// Save subscription (with better duplicate handling)
app.post('/subscribe', async (req, res) => {
  try {
    // First clean up any existing subscriptions with same endpoint
    await Subscription.deleteMany({ endpoint: req.body.endpoint });
    
    // Then create new one
    const subscription = new Subscription(req.body);
    await subscription.save();
    
    // Count total subscriptions
    const count = await Subscription.countDocuments();
    console.log(`📱 Subscription saved. Total active: ${count}`);
    
    res.status(201).json({ success: true, totalSubscriptions: count });
  } catch (err) {
    console.error('❌ Subscription save error:', err);
    res.status(500).json({ error: 'Failed to save subscription' });
  }
});

// Schedule notification with validation
app.post('/schedule', async (req, res) => {
  try {
    const { message, dateTime } = req.body;
    
    if (!message || !dateTime) {
      return res.status(400).json({ error: 'Message and dateTime are required' });
    }
    
    const scheduledTime = new Date(dateTime);
    const now = new Date();
    
    if (scheduledTime <= now) {
      return res.status(400).json({ error: 'Scheduled time must be in the future' });
    }
    
    const notification = await Notification.create({
      message: message.trim(),
      time: scheduledTime,
      sent: false
    });
    
    console.log(`📅 Scheduled notification: "${message}" for ${scheduledTime}`);
    res.json({ status: 'scheduled', id: notification._id });
  } catch (err) {
    console.error('❌ Schedule error:', err);
    res.status(500).json({ error: 'Failed to schedule notification' });
  }
});

// Get pending notifications only
app.get('/notifications', async (req, res) => {
  try {
    const notifications = await Notification.find({ sent: false })
      .sort({ time: 1 })
      .limit(100); // Limit results for performance
    res.json(notifications);
  } catch (err) {
    console.error('❌ Get notifications error:', err);
    res.status(500).json({ error: 'Failed to get notifications' });
  }
});

// Delete notification
app.delete('/notifications/:id', async (req, res) => {
  try {
    const result = await Notification.findByIdAndDelete(req.params.id);
    if (!result) {
      return res.status(404).json({ error: 'Notification not found' });
    }
    res.json({ status: 'deleted' });
  } catch (err) {
    console.error('❌ Delete error:', err);
    res.status(500).json({ error: 'Failed to delete notification' });
  }
});

// Update notification
app.put('/notifications/:id', async (req, res) => {
  try {
    const { message, dateTime } = req.body;
    
    if (!message || !dateTime) {
      return res.status(400).json({ error: 'Message and dateTime are required' });
    }
    
    const scheduledTime = new Date(dateTime);
    // const now = new Date();
    
    // if (scheduledTime <= now) {
    //   return res.status(400).json({ error: 'Scheduled time must be in the future' });
    // }
    
    const result = await Notification.findByIdAndUpdate(
      req.params.id,
      {
        message: message.trim(),
        time: scheduledTime,
        sent: false,
        attempts: 0 
      },
      { new: true }
    );
    
    if (!result) {
      return res.status(404).json({ error: 'Notification not found' });
    }
    
    res.json({ status: 'updated' });
  } catch (err) {
    console.error('❌ Update error:', err);
    res.status(500).json({ error: 'Failed to update notification' });
  }
});

// NEW: Cleanup duplicate subscriptions endpoint
app.post('/cleanup-subscriptions', async (req, res) => {
  try {
    // Find all unique endpoints
    const uniqueEndpoints = await Subscription.distinct('endpoint');
    
    let duplicatesRemoved = 0;
    
    // For each endpoint, keep only the latest one
    for (const endpoint of uniqueEndpoints) {
      const subs = await Subscription.find({ endpoint }).sort({ createdAt: -1 });
      
      if (subs.length > 1) {
        // Keep first (latest), delete rest
        const toDelete = subs.slice(1).map(s => s._id);
        await Subscription.deleteMany({ _id: { $in: toDelete } });
        duplicatesRemoved += toDelete.length;
      }
    }
    
    const totalRemaining = await Subscription.countDocuments();
    
    console.log(`🧹 Cleanup completed. Removed ${duplicatesRemoved} duplicates. Total remaining: ${totalRemaining}`);
    
    res.json({ 
      removed: duplicatesRemoved, 
      remaining: totalRemaining,
      uniqueDevices: uniqueEndpoints.length
    });
    
  } catch (err) {
    console.error('❌ Cleanup error:', err);
    res.status(500).json({ error: 'Cleanup failed' });
  }
});

// Get subscription stats
app.get('/subscription-stats', async (req, res) => {
  try {
    const total = await Subscription.countDocuments();
    const uniqueEndpoints = await Subscription.distinct('endpoint');
    
    res.json({
      totalSubscriptions: total,
      uniqueDevices: uniqueEndpoints.length,
      duplicates: total - uniqueEndpoints.length
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

// MAIN NOTIFICATION SENDER FUNCTION
async function processNotifications() {
  if (isJobRunning) {
    console.log('⏳ Job already running, skipping...');
    return;
  }
  
  isJobRunning = true;
  
  try {
    const now = new Date();
    console.log(`🔍 Checking for notifications at ${now.toISOString()}`);
    
    // Find notifications that are due and not sent
    const dueNotifications = await Notification.find({
      time: { $lte: now },
      sent: false
    }).limit(10); // Process max 10 at a time
    
    if (dueNotifications.length === 0) {
      console.log('✅ No notifications to send');
      return;
    }
    
    console.log(`📬 Found ${dueNotifications.length} notifications to send`);
    
    // Get all active subscriptions
    const subscriptions = await Subscription.find();
    
    if (subscriptions.length === 0) {
      console.log('⚠️ No subscriptions found');
      // Mark notifications as sent anyway to avoid accumulation
      await Notification.updateMany(
        { _id: { $in: dueNotifications.map(n => n._id) } },
        { sent: true, sentAt: now }
      );
      return;
    }
    
    // Process each notification
    for (const notification of dueNotifications) {
      try {
        console.log(`📤 Sending: "${notification.message}"`);
        
        // IMPORTANT: Mark as sent IMMEDIATELY to prevent duplicates
        await Notification.findByIdAndUpdate(notification._id, {
          sent: true,
          sentAt: now,
          attempts: notification.attempts + 1
        });
        
        // Send to all subscribers
        const payload = JSON.stringify({
          message: notification.message,
          timestamp: now.toISOString()
        });
        
        const sendPromises = subscriptions.map(async (sub) => {
          try {
            await webpush.sendNotification(sub.toObject(), payload);
            return { success: true, sub: sub._id };
          } catch (error) {
            console.error(`❌ Send failed for subscription ${sub._id}:`, error.message);
            
            // Remove invalid subscriptions
            if (error.statusCode === 410) {
              await Subscription.findByIdAndDelete(sub._id);
              console.log(`🗑️ Removed invalid subscription ${sub._id}`);
            }
            
            return { success: false, sub: sub._id, error: error.message };
          }
        });
        
        const results = await Promise.allSettled(sendPromises);
        const successful = results.filter(r => r.status === 'fulfilled' && r.value.success).length;
        
        console.log(`✅ Notification sent successfully to ${successful}/${subscriptions.length} subscribers`);
        
      } catch (error) {
        console.error(`❌ Error processing notification ${notification._id}:`, error);
      }
    }
    
  } catch (error) {
    console.error('❌ Fatal error in processNotifications:', error);
  } finally {
    isJobRunning = false;
  }
}

// Run notification checker every 15 seconds for better accuracy
const notificationInterval = setInterval(processNotifications, 15000);

// Cleanup old sent notifications daily
setInterval(async () => {
  try {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    const result = await Notification.deleteMany({
      sent: true,
      sentAt: { $lt: threeDaysAgo }
    });
    if (result.deletedCount > 0) {
      console.log(`🧹 Cleaned up ${result.deletedCount} old notifications`);
    }
  } catch (err) {
    console.error('❌ Cleanup error:', err);
  }
}, 24 * 60 * 60 * 1000); // Daily cleanup

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('🛑 Shutting down gracefully...');
  clearInterval(notificationInterval);
  mongoose.connection.close().then(() => {
    console.log('📴 MongoDB connection closed');
    process.exit(0);
  });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log('🔔 Notification system ready');
  
  // Run initial check after 5 seconds
  setTimeout(processNotifications, 5000);
});