// ==== Firebase config ====
const firebaseConfig = {
  apiKey: "AIzaSyCwtaV0gXnUuJ3dX41YyJ27cRNmTm7DdQQ",
  authDomain: "chat-ec8f0.firebaseapp.com",
  databaseURL: "https://chat-ec8f0-default-rtdb.firebaseio.com",
  projectId: "chat-ec8f0",
  storageBucket: "chat-ec8f0.appspot.com",
  messagingSenderId: "626029985493",
  appId: "1:626029985493:web:bb22915a5fd55ed1e2ac5c"
};

// Firebase init
firebase.initializeApp(firebaseConfig);
const database = firebase.database();

// ==== Variables ====
let pc;
let dataChannel;
let roomCode;
let isHost = false;

// ==== DOM Elements ====
const roomCodeInput = document.getElementById('room-code');
const joinRoomButton = document.getElementById('join-room');
const createRoomButton = document.getElementById('create-room');
const chatContainer = document.getElementById('chat-container');
const chatBox = document.getElementById('chat-box');
const messageInput = document.getElementById('message-input');
const sendMessageButton = document.getElementById('send-message');
const statusDiv = document.getElementById('status');
const roomInfoDiv = document.getElementById('room-info');
const displayRoomCode = document.getElementById('display-room-code');

// ==== Event Listeners ====
createRoomButton.onclick = async () => {
  clearChat();
  isHost = true;
  roomCode = Math.floor(100000 + Math.random() * 900000).toString();
  displayRoomCode.textContent = roomCode;
  roomInfoDiv.classList.remove('hidden');
  setStatus("Room created. Waiting for someone to join...");
  await startConnection();
};

joinRoomButton.onclick = async () => {
  clearChat();
  isHost = false;
  roomCode = roomCodeInput.value.trim();
  if (!roomCode) {
    alert("Enter room code");
    return;
  }
  setStatus(`Joining room ${roomCode}...`);
  await startConnection();
};

// ==== Start Connection ====
async function startConnection() {
  chatContainer.classList.remove('hidden');

  pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });

  pc.onicecandidate = event => {
    if (event.candidate) {
      const candidateRef = isHost
        ? database.ref(`${roomCode}/callerCandidates`)
        : database.ref(`${roomCode}/calleeCandidates`);
      candidateRef.push(event.candidate.toJSON());
    }
  };

  if (isHost) {
    dataChannel = pc.createDataChannel("chat");
    setupDataChannel();

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await database.ref(`${roomCode}/offer`).set(offer);

    // Listen for answer
    database.ref(`${roomCode}/answer`).on('value', async snap => {
      const answer = snap.val();
      if (answer && !pc.currentRemoteDescription) {
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
      }
    });

  } else {
    pc.ondatachannel = event => {
      dataChannel = event.channel;
      setupDataChannel();
    };

    // Get offer from DB
    const offerSnap = await database.ref(`${roomCode}/offer`).once('value');
    if (!offerSnap.exists()) {
      setStatus("❌ No such room or host not ready yet.");
      return;
    }
    setStatus("Offer received from host. Creating answer...");
    const offer = offerSnap.val();
    await pc.setRemoteDescription(new RTCSessionDescription(offer));

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await database.ref(`${roomCode}/answer`).set(answer);
  }

  // Listen for ICE candidates from other side
  const otherCandidatesRef = isHost
    ? database.ref(`${roomCode}/calleeCandidates`)
    : database.ref(`${roomCode}/callerCandidates`);

  otherCandidatesRef.on('child_added', async snap => {
    const candidate = snap.val();
    if (candidate) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (e) {
        console.error('Error adding ICE candidate', e);
      }
    }
  });

  sendMessageButton.onclick = () => {
    const msg = messageInput.value;
    if (msg && dataChannel && dataChannel.readyState === 'open') {
      dataChannel.send(msg);
      displayMessage(msg, 'me');
      messageInput.value = '';
    }
  };
}

// ==== DataChannel setup ====
function setupDataChannel() {
  dataChannel.onopen = () => {
    setStatus("✅ Connected");
  };
  dataChannel.onmessage = e => {
    displayMessage(e.data, 'peer');
  };
}

// ==== Display messages ====
function displayMessage(message, sender) {
  const messageElement = document.createElement('div');
  messageElement.classList.add('message', sender);
  messageElement.textContent = message;
  chatBox.appendChild(messageElement);
  chatBox.scrollTop = chatBox.scrollHeight;
}

// ==== Status updater ====
function setStatus(text) {
  statusDiv.textContent = text;
}

// ==== Clear chat ====
function clearChat() {
  chatBox.innerHTML = '';
  messageInput.value = '';
  statusDiv.textContent = '';
}

// ==== Clear chat on page reload ====
window.addEventListener('beforeunload', clearChat);
