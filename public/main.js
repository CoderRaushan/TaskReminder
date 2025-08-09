
const publicVapidKey = 'BNJ3zMpwqw4YGHVNIpxhhY1mF4YwN_PXWbal6qf9--iQYJ3yS5JMRWtFBNG5y6Skw8v_bUWRjMedTpcazL_XDys';

async function init() {
  if ('serviceWorker' in navigator) {
    const reg = await navigator.serviceWorker.register('/sw.js');
    const subscription = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicVapidKey)
    });
    await fetch('/subscribe', {
      method: 'POST',
      body: JSON.stringify(subscription),
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

init();

document.getElementById('form').onsubmit = async e => {
  e.preventDefault();
  const message = document.getElementById('msg').value;
  const dateTime = document.getElementById('datetime').value;
  await fetch('/schedule', {
    method: 'POST',
    body: JSON.stringify({ message, dateTime }),
    headers: { 'Content-Type': 'application/json' }
  });
  document.getElementById('form').reset();
  loadNotifications();
};

async function loadNotifications() {
  const res = await fetch('/notifications');
  const data = await res.json();
  const list = document.getElementById('list');
  list.innerHTML = "";
  data.forEach(n => {
    const div = document.createElement('div');
    div.className = "item";
    div.innerHTML = `
      <span>${n.message} <br><small>${new Date(n.time).toLocaleString()}</small></span>
      <span class="actions">
        <i class="fa fa-edit" onclick="editNotif('${n._id}', '${n.message}', '${n.time}')"></i>
        <i class="fa fa-trash" onclick="deleteNotif('${n._id}')"></i>
      </span>
    `;
    list.appendChild(div);
  });
}

async function deleteNotif(id) {
  await fetch('/notifications/' + id, { method: 'DELETE' });
  loadNotifications();
}

async function editNotif(id, oldMsg, oldTime) {
  const newMsg = prompt("Edit message:", oldMsg);
  if (newMsg === null) return;
  const newTime = prompt("Edit date/time (YYYY-MM-DD HH:MM):", new Date(oldTime).toISOString().slice(0,16));
  if (newTime === null) return;
  await fetch('/notifications/' + id, {
    method: 'PUT',
    body: JSON.stringify({ message: newMsg, dateTime: newTime }),
    headers: { 'Content-Type': 'application/json' }
  });
  loadNotifications();
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/\-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

loadNotifications();
