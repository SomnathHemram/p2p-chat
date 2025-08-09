// ==================== CONFIG - replace with your Firebase config ====================
const firebaseConfig = {
  apiKey: "AIzaSyCwtaV0gXnUuJ3dX41YyJ27cRNmTm7DdQQ",
  authDomain: "chat-ec8f0.firebaseapp.com",
  databaseURL: "https://chat-ec8f0-default-rtdb.firebaseio.com",
  projectId: "chat-ec8f0",
  storageBucket: "chat-ec8f0.appspot.com",
  messagingSenderId: "626029985493",
  appId: "1:626029985493:web:bb22915a5fd55ed1e2ac5c"
};
// =====================================================================================

// initialize Firebase (v8)
firebase.initializeApp(firebaseConfig);
const database = firebase.database();

// ======= App state =======
let pc = null;
let dataChannel = null;
let roomCode = null;
let isHost = false;
let localStream = null;
const chunkSize = 16 * 1024; // 16 KB chunks

// ======= DOM =======
const roomCodeInput = document.getElementById('room-code');
const joinRoomButton = document.getElementById('join-room');
const createRoomButton = document.getElementById('create-room');
const displayRoomCode = document.getElementById('display-room-code');
const displayRoomCodeInline = document.getElementById('display-room-code-inline');
const roomInfo = document.getElementById('room-info');
const leaveRoomBtn = document.getElementById('leave-room');
const statusDiv = document.getElementById('status');
const chatArea = document.getElementById('chat-area');
const chatBox = document.getElementById('chat-box');
const messageInput = document.getElementById('message-input');
const sendMessageButton = document.getElementById('send-message');
const fileInput = document.getElementById('file-input');
const sendFileBtn = document.getElementById('send-file');
const fileProgress = document.getElementById('file-progress');
const startMediaBtn = document.getElementById('start-media');
const stopMediaBtn = document.getElementById('stop-media');
const localVideo = document.getElementById('localVideo');
const remoteVideo = document.getElementById('remoteVideo');
const cameraSelect = document.getElementById('cameraSelect');
const micSelect = document.getElementById('micSelect');
const localVideoWrap = document.getElementById('localVideoWrap');
const remoteVideoWrap = document.getElementById('remoteVideoWrap');


// ======= Ask permission & load devices =======
async function populateDeviceLists() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    cameraSelect.innerHTML = '';
    micSelect.innerHTML = '';
    devices.forEach(d => {
      const option = document.createElement('option');
      option.value = d.deviceId;
      option.text = d.label || `${d.kind}`;
      if (d.kind === 'videoinput') cameraSelect.appendChild(option);
      if (d.kind === 'audioinput') micSelect.appendChild(option);
    });
  } catch (err) {
    console.warn('Error listing devices', err);
  }
}

// Request permission first so labels appear
async function initDevices() {
  try {
    await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    await populateDeviceLists();
  } catch (err) {
    console.error('Device access denied', err);
  }
}
initDevices();

// Update list if devices change (plug in/out)
navigator.mediaDevices.addEventListener('devicechange', populateDeviceLists);
 

// ======= UI helpers =======
function setStatus(t) { statusDiv.textContent = t; }
function showChat() { chatArea.classList.remove('hidden'); }
function hideChat() { chatArea.classList.add('hidden'); }
function clearChat() {
  chatBox.innerHTML = '';
  messageInput.value = '';
  fileProgress.textContent = '';
  setStatus('');
}
function showRoomCode(code) {
  displayRoomCode.textContent = code;
  if (displayRoomCodeInline) displayRoomCodeInline.textContent = code;
  roomInfo.classList.remove('hidden');
}
function hideRoomCode() {
  roomInfo.classList.add('hidden');
  displayRoomCode.textContent = '';
  if (displayRoomCodeInline) displayRoomCodeInline.textContent = '';
}

// ======= Device list population =======
async function populateDeviceLists() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    cameraSelect.innerHTML = '';
    micSelect.innerHTML = '';
    devices.forEach(d => {
      const option = document.createElement('option');
      option.value = d.deviceId;
      option.text = d.label || `${d.kind}`;
      if (d.kind === 'videoinput') cameraSelect.appendChild(option);
      if (d.kind === 'audioinput') micSelect.appendChild(option);
    });
  } catch (err) {
    console.warn('Error listing devices', err);
  }
}
populateDeviceLists();
navigator.mediaDevices.addEventListener('devicechange', populateDeviceLists);

// ======= Message display =======
function displayMessage(text, who = 'peer') {
  const el = document.createElement('div');
  el.className = 'message ' + (who === 'me' ? 'me' : 'peer');
  el.textContent = text;
  chatBox.appendChild(el);
  chatBox.scrollTop = chatBox.scrollHeight;
}

// ======= Helpers for Firebase room paths =======
function roomRef(path = '') { return database.ref(`rooms/${roomCode}/${path}`); }
function setRoomTimestamp() { roomRef('ts').set(Date.now()); }
async function roomExists(code) {
  const snap = await database.ref(`rooms/${code}/offer`).once('value');
  return snap.exists();
}

// ======= Create / Join UI flow =======
createRoomButton.onclick = async () => {
  clearChat();
  isHost = true;
  roomCode = Math.floor(100000 + Math.random() * 900000).toString();
  showRoomCode(roomCode);
  setStatus('Room created. Waiting for a joiner...');
  setRoomTimestamp();
  await startConnection();
};

joinRoomButton.onclick = async () => {
  clearChat();
  isHost = false;
  const code = roomCodeInput.value.trim();
  if (!/^\d{6}$/.test(code)) { alert('Enter a 6-digit room code'); return; }
  roomCode = code;
  setStatus(`Joining room ${roomCode}...`);
  const tsSnap = await database.ref(`rooms/${roomCode}/ts`).once('value');
  if (tsSnap.exists()) {
    const ts = tsSnap.val();
    if (Date.now() - ts > 30 * 60 * 1000) {
      alert('Room expired (older than 30 minutes).');
      return;
    }
  }
  if (!(await roomExists(roomCode))) {
    alert('No such room / host not ready.');
    return;
  }
  showRoomCode(roomCode);
  await startConnection();
};

leaveRoomBtn.onclick = async () => {
  await cleanupAndClose(true);
  clearChat();
  hideRoomCode();
  hideChat();
  setStatus('Left room');
};

// ======= Start/Stop media buttons =======
startMediaBtn.onclick = async () => {
  try {
    const constraints = {
      audio: micSelect.value ? { deviceId: { exact: micSelect.value } } : true,
      video: cameraSelect.value ? { deviceId: { exact: cameraSelect.value } } : true
    };
    localStream = await navigator.mediaDevices.getUserMedia(constraints);
    localVideo.srcObject = localStream;
    localVideoWrap.classList.remove('hidden');

    if (pc) {
      for (const t of localStream.getTracks()) pc.addTrack(t, localStream);
      await renegotiate();
    }
    startMediaBtn.disabled = true;
    stopMediaBtn.disabled = false;
  } catch (e) {
    console.error('getUserMedia error', e);
    alert('Could not get media: ' + e.message);
  }
};

stopMediaBtn.onclick = async () => {
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
    localVideo.srcObject = null;
    setStatus('Media stopped.');
  }
  startMediaBtn.disabled = false;
  stopMediaBtn.disabled = true;
};

// ======= File sending logic with backpressure =======
let sendingFile = null;
sendFileBtn.onclick = async () => {
  const file = fileInput.files[0];
  if (!file || !dataChannel || dataChannel.readyState !== 'open') { alert('Select file and ensure connected'); return; }
  sendingFile = { name: file.name, size: file.size, type: file.type };
  dataChannel.send(JSON.stringify({ t: 'file-meta', ...sendingFile }));
  let offset = 0;
  fileProgress.textContent = '0%';
  while (offset < file.size) {
    while (dataChannel.bufferedAmount > 65536) {
      await new Promise(r => setTimeout(r, 100));
    }
    const slice = await file.slice(offset, offset + chunkSize).arrayBuffer();
    dataChannel.send(slice);
    offset += slice.byteLength;
    fileProgress.textContent = Math.floor(offset / file.size * 100) + '%';
  }
  dataChannel.send(JSON.stringify({ t: 'file-end' }));
  fileProgress.textContent = 'Sent 100%';
  sendingFile = null;
};

let incomingFile = null;
let incomingBuffers = [];

// ======= Core WebRTC & signaling =======
async function startConnection() {
  showChat();
  pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });

  if (isHost) {
    dataChannel = pc.createDataChannel('chat');
    setupDataChannel();
  } else {
    pc.ondatachannel = (e) => {
      dataChannel = e.channel;
      setupDataChannel();
    };
  }

  pc.ontrack = (ev) => { remoteVideo.srcObject = ev.streams[0]; };
remoteVideoWrap.classList.remove('hidden');

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      const path = isHost ? 'callerCandidates' : 'calleeCandidates';
      roomRef(path).push(e.candidate.toJSON());
    }
  };

  const otherCandidatesPath = isHost ? 'calleeCandidates' : 'callerCandidates';
  roomRef(otherCandidatesPath).on('child_added', snapshot => {
    const cand = snapshot.val();
    if (cand) pc.addIceCandidate(new RTCIceCandidate(cand)).catch(e => console.warn('addIce error', e));
  });

  if (isHost) {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await roomRef('offer').set(offer);
    setRoomTimestamp();
    setStatus('Offer created. Waiting for answer...');
    roomRef('answer').on('value', async snap => {
      const answer = snap.val();
      if (answer && !pc.currentRemoteDescription) {
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
        setStatus('Connected');
      }
    });
  } else {
    const offerSnap = await roomRef('offer').once('value');
    if (!offerSnap.exists()) { setStatus('❌ No such room / host not ready.'); return; }
    await pc.setRemoteDescription(new RTCSessionDescription(offerSnap.val()));
    setStatus('Offer received. Creating answer...');
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await roomRef('answer').set(answer);
    setRoomTimestamp();
    setStatus('Answer sent. Completing connection...');
  }

  sendMessageButton.onclick = () => {
    const txt = messageInput.value.trim();
    if (!txt || !dataChannel || dataChannel.readyState !== 'open') return;
    dataChannel.send(JSON.stringify({ t: 'msg', text: txt }));
    displayMessage(txt, 'me');
    messageInput.value = '';
  };

  window.addEventListener('beforeunload', async () => {
    await cleanupAndClose(true);
  });
}

function setupDataChannel() {
  dataChannel.onopen = () => setStatus('✅ Connected');
  dataChannel.onmessage = async (ev) => {
    if (typeof ev.data === 'string') {
      try {
        const obj = JSON.parse(ev.data);
        if (obj.t === 'msg') {
          displayMessage(obj.text, 'peer');
        } else if (obj.t === 'file-meta') {
          incomingFile = { name: obj.name, size: obj.size, type: obj.type };
          incomingBuffers = [];
          fileProgress.textContent = `Receiving ${incomingFile.name} (0%)`;
        } else if (obj.t === 'file-end') {
          const blob = new Blob(incomingBuffers, { type: incomingFile.type || 'application/octet-stream' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = incomingFile.name;
          a.textContent = `Download ${incomingFile.name} (${Math.round(incomingFile.size / 1024)} KB)`;
          chatBox.appendChild(a);
          chatBox.scrollTop = chatBox.scrollHeight;
          fileProgress.textContent = 'Received 100%';
          incomingFile = null;
          incomingBuffers = [];
        }
      } catch (e) { }
    } else if (ev.data instanceof ArrayBuffer) {
      incomingBuffers.push(ev.data);
      if (incomingFile) {
        const receivedBytes = incomingBuffers.reduce((s, b) => s + b.byteLength, 0);
        const pct = Math.floor(receivedBytes / incomingFile.size * 100);
        fileProgress.textContent = `Receiving ${incomingFile.name} (${pct}%)`;
      }
    }
  };
}

async function renegotiate() {
  if (!pc || !roomCode) return;
  setStatus('Renegotiating...');
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await roomRef('offer').set(offer);
}

async function cleanupAndClose(removeRoom = false) {
  try {
    if (pc) pc.close();
    pc = null;
    dataChannel = null;
    if (removeRoom && isHost && roomCode) {
      await database.ref(`rooms/${roomCode}`).remove();
    }
  } catch (e) { console.warn('cleanup error', e); }
}
