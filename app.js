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

// ======= UI helpers =======
function setStatus(t){ statusDiv.textContent = t; }
function showChat(){ chatArea.classList.remove('hidden'); }
function hideChat(){ chatArea.classList.add('hidden'); }
function clearChat(){ chatBox.innerHTML = ''; messageInput.value = ''; fileProgress.textContent = ''; setStatus(''); }
function showRoomCode(code){ displayRoomCode.textContent = code; roomInfo.classList.remove('hidden'); }
function hideRoomCode(){ roomInfo.classList.add('hidden'); displayRoomCode.textContent = ''; }

// ======= Message display =======
function displayMessage(text, who='peer'){
  const el = document.createElement('div');
  el.className = 'message ' + (who === 'me' ? 'me' : 'peer');
  el.textContent = text;
  chatBox.appendChild(el);
  chatBox.scrollTop = chatBox.scrollHeight;
}

// ======= Helpers for Firebase room paths =======
function roomRef(path=''){ return database.ref(`rooms/${roomCode}/${path}`); }
function setRoomTimestamp(){ roomRef('ts').set(Date.now()); }
async function roomExists(code){
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
  if(!/^\d{6}$/.test(code)){ alert('Enter a 6-digit room code'); return; }
  roomCode = code;
  setStatus(`Joining room ${roomCode}...`);
  // optionally check TTL
  const tsSnap = await database.ref(`rooms/${roomCode}/ts`).once('value');
  if(tsSnap.exists()){
    const ts = tsSnap.val();
    if(Date.now() - ts > 30*60*1000){ // older than 30 mins
      alert('Room expired (older than 30 minutes).');
      return;
    }
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
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    localVideo.srcObject = localStream;
    // add tracks to pc (if exists) and renegotiate
    if(pc){
      for(const t of localStream.getTracks()) pc.addTrack(t, localStream);
      await renegotiate();
    }
    startMediaBtn.disabled = true;
    stopMediaBtn.disabled = false;
    setStatus(prev => prev); // keep current status
  } catch (e) {
    console.error('getUserMedia error', e);
    alert('Could not get media: ' + e.message);
  }
};

stopMediaBtn.onclick = async () => {
  if(localStream){
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
    localVideo.srcObject = null;
    // can't reliably remove tracks easily; easiest is to recreate connection if needed.
    setStatus('Media stopped (you may need to reconnect to remove tracks).');
  }
  startMediaBtn.disabled = false;
  stopMediaBtn.disabled = true;
};

// ======= File sending logic (chunked) =======
let sendingFile = null;
sendFileBtn.onclick = async () => {
  const file = fileInput.files[0];
  if(!file || !dataChannel || dataChannel.readyState !== 'open'){ alert('Select file and ensure connected'); return; }
  sendingFile = { name: file.name, size: file.size, type: file.type };
  // send metadata as JSON
  dataChannel.send(JSON.stringify({ t:'file-meta', name: file.name, size: file.size, type: file.type }));
  const reader = new FileReader();
  let offset = 0;
  fileProgress.textContent = '0%';
  reader.onload = (e) => {
    const buffer = e.target.result;
    // send as ArrayBuffer
    dataChannel.send(buffer);
    offset += buffer.byteLength;
    fileProgress.textContent = Math.floor(offset / file.size * 100) + '%';
    if(offset < file.size){
      readSlice(offset);
    } else {
      dataChannel.send(JSON.stringify({ t:'file-end' }));
      fileProgress.textContent = 'Sent 100%';
      sendingFile = null;
    }
  };
  reader.onerror = (err) => {
    console.error('File read error', err);
  };
  function readSlice(o){
    const slice = file.slice(o, o + chunkSize);
    reader.readAsArrayBuffer(slice);
  }
  readSlice(0);
};

// receiver state for incoming file
let incomingFile = null;
let incomingBuffers = [];

// ======= Core WebRTC & signaling =======
async function startConnection(){
  showChat();
  pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });

  // Data channel setup
  if(isHost){
    dataChannel = pc.createDataChannel('chat');
    setupDataChannel();
  } else {
    pc.ondatachannel = (e) => {
      dataChannel = e.channel;
      setupDataChannel();
    };
  }

  // Remote media
  pc.ontrack = (ev) => {
    remoteVideo.srcObject = ev.streams[0];
  };

  // ICE handling
  pc.onicecandidate = (e) => {
    if(e.candidate){
      const path = isHost ? 'callerCandidates' : 'calleeCandidates';
      roomRef(path).push(e.candidate.toJSON());
    }
  };

  // Listen for ICE from other peer
  const otherCandidatesPath = isHost ? 'calleeCandidates' : 'callerCandidates';
  roomRef(otherCandidatesPath).on('child_added', snapshot => {
    const cand = snapshot.val();
    if(cand){
      pc.addIceCandidate(new RTCIceCandidate(cand)).catch(e => console.warn('addIce error', e));
    }
  });

  if(isHost){
    // Create initial offer
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await roomRef('offer').set(offer);
    setRoomTimestamp();
    setStatus('Offer created. Waiting for answer...');

    // Listen for answers (including renegotiations)
    roomRef('answer').on('value', async snap => {
      const answer = snap.val();
      if(answer && (!pc.currentRemoteDescription || answer.sdp !== pc.remoteDescription.sdp)){
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
        setStatus('✅ Connected');
      }
    });

  } else {
    // Joiner listens for offers (initial + renegotiations)
    roomRef('offer').on('value', async snap => {
      const offer = snap.val();
      if(!offer) return;

      if(!pc.currentRemoteDescription || offer.sdp !== pc.remoteDescription.sdp){
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await roomRef('answer').set(answer);
        setRoomTimestamp();
        setStatus('Answer sent. Connection updated.');
      }
    });
  }

  // Send message handler
  sendMessageButton.onclick = () => {
    const txt = messageInput.value.trim();
    if(!txt || !dataChannel || dataChannel.readyState !== 'open') return;
    dataChannel.send(JSON.stringify({ t:'msg', text: txt }));
    displayMessage(txt, 'me');
    messageInput.value = '';
  };

  // Cleanup on unload
  window.addEventListener('beforeunload', async () => {
    await cleanupAndClose(true);
  });
}


// data channel message handling
function setupDataChannel(){
  dataChannel.onopen = () => {
    setStatus('✅ Connected');
  };

  dataChannel.onmessage = async (ev) => {
    // ev.data might be string (JSON) or ArrayBuffer (file chunk)
    if(typeof ev.data === 'string'){
      try {
        const obj = JSON.parse(ev.data);
        if(obj.t === 'msg'){
          displayMessage(obj.text, 'peer');
        } else if(obj.t === 'file-meta'){
          // prepare for incoming file
          incomingFile = { name: obj.name, size: obj.size, type: obj.type };
          incomingBuffers = [];
          fileProgress.textContent = `Receiving ${incomingFile.name} (0%)`;
        } else if(obj.t === 'file-end'){
          // assemble file and offer download
          const blob = new Blob(incomingBuffers, { type: incomingFile.type || 'application/octet-stream' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = incomingFile.name;
          a.textContent = `Download ${incomingFile.name} (${Math.round(incomingFile.size/1024)} KB)`;
          const wrap = document.createElement('div');
          wrap.appendChild(a);
          chatBox.appendChild(wrap);
          chatBox.scrollTop = chatBox.scrollHeight;
          fileProgress.textContent = 'Received 100%';
          incomingFile = null;
          incomingBuffers = [];
        } else if(obj.t === 'renegotiate'){
          // remote asks for renegotiation: create answer if we're joiner
          // (we ignore these here because we use DB offer/answer mechanism)
        }
      } catch(e){
        // not JSON - ignore
        console.warn('JSON parse fail', e);
      }
    } else if(ev.data instanceof ArrayBuffer){
      // file chunk
      incomingBuffers.push(ev.data);
      if(incomingFile){
        const receivedBytes = incomingBuffers.reduce((s,b)=> s + b.byteLength, 0);
        const pct = Math.floor(receivedBytes / incomingFile.size * 100);
        fileProgress.textContent = `Receiving ${incomingFile.name} (${pct}%)`;
      }
    } else if(ev.data instanceof Blob){
      const ab = await ev.data.arrayBuffer();
      incomingBuffers.push(ab);
    }
  };
}

// renegotiate: creates a new offer, writes to DB (overwrites offer), joiner will create answer
async function renegotiate(){
  if(!pc || !roomCode) return;
  setStatus('Renegotiating (updating tracks)...');
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await roomRef('offer').set(offer);
  // joiner will pick up offer and produce answer; host listens for answer (as earlier)
}

// cleanup function to remove room from DB if host and close pc
async function cleanupAndClose(removeRoom=false){
  try {
    if(pc) pc.close();
    pc = null;
    dataChannel = null;
    if(removeRoom && isHost && roomCode){
      await database.ref(`rooms/${roomCode}`).remove();
    }
  } catch (e){ console.warn('cleanup error', e); }
}

// ======= Simple TTL housekeeping idea =======
// When creating a room we set ts. Clients check ts on join and reject if older than 30 minutes.
// Fully automated server-side TTL requires functions; this is a client-side check.

// ==================== End of app.js ====================
