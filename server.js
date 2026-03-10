const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============================================
// IN-MEMORY DATA STORE
// ============================================

const state = {
  // Users currently connected
  users: new Map(),
  
  // Notes: { noteId: { id, name, type, users, messages, children, parent, visibility, writable } }
  notes: {
    cover: {
      id: 'cover',
      name: 'ARS NOTORIA',
      type: 'notebook',
      users: [], // empty = everyone has access
      messages: [],
      threads: {},
      children: [],
      parent: null,
      isSpecial: true,
      visibility: 'public',
      writable: true
    }
  },
  
  // Artifacts: { id: { name, type, creator, creatorType, contributors, versions } }
  artifacts: {},
  
  // Wallets: { odket
  wallets: {},
  
  // Registered bot webhooks: { odket
  bots: {}
};

let messageIdCounter = 0;
let artifactIdCounter = 0;
let noteIdCounter = 0;

// ============================================
// HELPER FUNCTIONS
// ============================================

function getTimeString() {
  const now = new Date();
  return now.getHours().toString().padStart(2, '0') + ':' + 
         now.getMinutes().toString().padStart(2, '0');
}

function initWallet(userId) {
  if (!state.wallets[userId]) {
    state.wallets[userId] = {
      balance: 100000.00,
      transactions: []
    };
  }
  return state.wallets[userId];
}

function broadcastUserList() {
  const userList = Array.from(state.users.values()).map(u => ({
    id: u.id,
    name: u.name,
    type: u.type
  }));
  io.emit('userList', userList);
}

function canAccessNote(socketId, note) {
  // Cover is accessible to everyone
  if (note.isSpecial || note.id === 'cover') return true;
  
  const user = state.users.get(socketId);
  if (!user) return false;
  
  // Check this note directly
  if (note.users && note.users.includes(user.name)) return true;
  if (note.creator === user.name) return true;
  
  // Check ancestors - if user has access to any parent, they have access here
  let current = note;
  while (current.parent) {
    const parent = state.notes[current.parent];
    if (!parent) break;
    
    if (parent.users && parent.users.includes(user.name)) return true;
    if (parent.creator === user.name) return true;
    
    current = parent;
  }
  
  return false;
}

function getUsersInNote(noteId) {
  const note = state.notes[noteId];
  if (!note) return [];
  
  // For Cover, return all connected users
  if (note.isSpecial || noteId === 'cover') {
    return Array.from(state.users.keys());
  }
  
  // Find all connected users who have access (including via ancestors)
  const socketIds = [];
  state.users.forEach((user, socketId) => {
    if (canAccessNote(socketId, note)) {
      socketIds.push(socketId);
    }
  });
  
  return socketIds;
}

// Add user to a note and all its children recursively
function addUserToNoteTree(noteId, userName) {
  const note = state.notes[noteId];
  if (!note) return;
  
  if (!note.users) note.users = [];
  if (!note.users.includes(userName)) {
    note.users.push(userName);
  }
  
  // Recurse into children
  if (note.children && note.children.length > 0) {
    note.children.forEach(childId => addUserToNoteTree(childId, userName));
  }
}

// Collect all notes in a tree (parent + all descendants)
function collectNoteTree(noteId) {
  const note = state.notes[noteId];
  if (!note) return [];
  
  let result = [note];
  if (note.children && note.children.length > 0) {
    note.children.forEach(childId => {
      result = result.concat(collectNoteTree(childId));
    });
  }
  return result;
}

function deleteNoteRecursive(noteId) {
  const note = state.notes[noteId];
  if (!note) return;
  
  // Delete children first
  if (note.children) {
    note.children.forEach(childId => deleteNoteRecursive(childId));
  }
  
  delete state.notes[noteId];
}

// ============================================
// SOCKET.IO HANDLERS
// ============================================

io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);
  
  // --------------------------------------------
  // JOIN - User identifies themselves
  // --------------------------------------------
  socket.on('join', (data) => {
    const { name, type } = data;
    
    state.users.set(socket.id, {
      id: socket.id,
      name,
      type,
      joinedAt: Date.now(),
      currentNote: 'cover'
    });
    
    // Initialize wallet
    initWallet(socket.id);
    
    console.log(`User joined: ${name} (${type})`);
    
    // Get notes this user has access to
    const userNotes = {};
    Object.entries(state.notes).forEach(([id, note]) => {
      if (canAccessNote(socket.id, note)) {
        userNotes[id] = note;
      }
    });
    
    // Send current state to new user
    socket.emit('init', {
      notes: userNotes,
      currentNote: 'cover',
      artifacts: state.artifacts,
      wallet: state.wallets[socket.id],
      users: Array.from(state.users.values()).map(u => ({ name: u.name, type: u.type })),
      agents: Object.values(state.bots).map(b => ({ name: b.name, owner: b.owner }))
    });
    
    // Broadcast updated user list
    broadcastUserList();
    
    // Notify others
    socket.broadcast.emit('userJoined', { name, type });
  });
  
  // --------------------------------------------
  // SWITCH NOTE
  // --------------------------------------------
  socket.on('switchNote', (data) => {
    const user = state.users.get(socket.id);
    if (!user) return;
    
    const { noteId } = data;
    const note = state.notes[noteId];
    
    if (note && canAccessNote(socket.id, note)) {
      user.currentNote = noteId;
      console.log(`${user.name} switched to note: ${noteId}`);
    }
  });
  
  // --------------------------------------------
  // CREATE NOTE
  // --------------------------------------------
  socket.on('createNote', (data) => {
    const user = state.users.get(socket.id);
    if (!user) return;
    
    const { name, parentId } = data;
    
    // Server assigns the ID
    const noteId = 'note-' + (++noteIdCounter);
    
    // Start with creator in users list
    let noteUsers = [user.name];
    let noteType = 'notebook';
    
    // Walk up the tree to find if any ancestor is shared
    // If so, inherit users from the nearest shared ancestor
    if (parentId) {
      let current = state.notes[parentId];
      while (current) {
        if (current.type === 'dm' && current.users && current.users.length > 1) {
          // Found a shared ancestor - inherit its users
          noteUsers = [...current.users];
          if (!noteUsers.includes(user.name)) {
            noteUsers.push(user.name);
          }
          noteType = 'dm';
          break;
        }
        // Walk up to parent
        current = current.parent ? state.notes[current.parent] : null;
      }
    }
    
    const note = {
      id: noteId,
      name: name,
      type: noteType,
      creator: user.name,
      users: noteUsers,
      messages: [],
      threads: {},
      children: [],
      parent: parentId || null,
      visibility: 'private',
      writable: true
    };
    
    state.notes[noteId] = note;
    
    // Add to parent's children if nested
    if (parentId && state.notes[parentId]) {
      state.notes[parentId].children.push(noteId);
    }
    
    console.log(`${user.name} created note: ${name} (${noteId}), users: ${noteUsers.join(', ')}`);
    
    // Send note to creator
    socket.emit('noteCreated', { note });
    
    // If shared (has other users), notify them too
    if (noteUsers.length > 1) {
      noteUsers.forEach(userName => {
        if (userName === user.name) return; // Skip creator, already sent
        
        const recipient = Array.from(state.users.values()).find(u => u.name === userName);
        if (recipient) {
          io.to(recipient.id).emit('noteCreated', { note });
        }
      });
    }
  });
  
  // --------------------------------------------
  // RENAME NOTE
  // --------------------------------------------
  socket.on('renameNote', (data) => {
    const user = state.users.get(socket.id);
    if (!user) return;
    
    const { noteId, name } = data;
    const note = state.notes[noteId];
    
    if (note && !note.isSpecial) {
      note.name = name;
      
      // Notify all users who have access
      const userIds = getUsersInNote(noteId);
      userIds.forEach(id => {
        io.to(id).emit('noteRenamed', { noteId, name });
      });
    }
  });
  
  // --------------------------------------------
  // DELETE NOTE
  // --------------------------------------------
  socket.on('deleteNote', (data) => {
    const user = state.users.get(socket.id);
    if (!user) return;
    
    const { noteId } = data;
    const note = state.notes[noteId];
    
    if (note && !note.isSpecial) {
      // Remove from parent
      if (note.parent && state.notes[note.parent]) {
        const idx = state.notes[note.parent].children.indexOf(noteId);
        if (idx > -1) state.notes[note.parent].children.splice(idx, 1);
      }
      
      // Delete recursively
      deleteNoteRecursive(noteId);
      
      // Notify users
      io.emit('noteDeleted', { noteId });
    }
  });
  
  // --------------------------------------------
  // DUPLICATE NOTE
  // --------------------------------------------
  socket.on('duplicateNote', (data) => {
    const user = state.users.get(socket.id);
    if (!user) return;
    
    const { sourceNoteId, newName } = data;
    const sourceNote = state.notes[sourceNoteId];
    
    if (!sourceNote) return;
    
    // Server assigns ID
    const newNoteId = 'note-' + (++noteIdCounter);
    
    // Create duplicate
    const newNote = {
      id: newNoteId,
      name: newName,
      type: 'notebook',
      creator: user.name,
      users: [user.name],
      messages: [...sourceNote.messages],
      threads: { ...sourceNote.threads },
      children: [],
      parent: null,
      visibility: 'private',
      writable: true
    };
    
    state.notes[newNoteId] = newNote;
    
    console.log(`${user.name} duplicated note ${sourceNoteId} as ${newNoteId}`);
    
    // Send to creator only
    socket.emit('noteCreated', { note: newNote });
  });
  
  // --------------------------------------------
  // CONVERT NOTE TO DM (when no existing DM)
  // --------------------------------------------
  socket.on('convertNoteToDM', (data) => {
    const user = state.users.get(socket.id);
    if (!user) return;
    
    const { noteId, userName } = data;
    const note = state.notes[noteId];
    
    if (!note) return;
    
    // Remove from old parent
    if (note.parent && state.notes[note.parent]) {
      const idx = state.notes[note.parent].children.indexOf(noteId);
      if (idx > -1) state.notes[note.parent].children.splice(idx, 1);
    }
    
    // Convert note to DM
    note.type = 'dm';
    note.name = userName; // Set name to the other person (for creator's view)
    note.parent = null;
    note.creator = user.name; // Set creator for DM lookup
    
    // Add both users to this note AND all children
    addUserToNoteTree(noteId, user.name);
    addUserToNoteTree(noteId, userName);
    
    console.log(`${user.name} converted note ${noteId} to DM with ${userName}, users: ${note.users}`);
    
    // Notify the recipient - send main note and all children
    const recipient = Array.from(state.users.values()).find(u => u.name === userName);
    if (recipient) {
      // Send main note
      const recipientNote = { ...note, name: user.name };
      io.to(recipient.id).emit('noteInvite', { 
        note: recipientNote, 
        fromUser: user.name 
      });
      
      // Send all children
      const allNotes = collectNoteTree(noteId);
      allNotes.forEach(n => {
        if (n.id !== noteId) {
          io.to(recipient.id).emit('noteInvite', {
            note: n,
            fromUser: user.name
          });
        }
      });
    }
  });
  
  // --------------------------------------------
  // SHARE NOTE WITH USER (move notebook under DM)
  // --------------------------------------------
  socket.on('shareNoteWithUser', (data) => {
    const user = state.users.get(socket.id);
    if (!user) return;
    
    const { noteId, userName, dmId } = data;
    const note = state.notes[noteId];
    
    if (!note) return;
    
    // Find or create the DM
    let dm = state.notes[dmId];
    if (!dm) {
      // Create the DM
      dm = {
        id: dmId,
        name: userName,
        type: 'dm',
        creator: user.name,
        users: [user.name, userName],
        messages: [],
        threads: {},
        children: [],
        parent: null,
        visibility: 'private',
        writable: true
      };
      state.notes[dmId] = dm;
    }
    
    // Remove note from old parent
    if (note.parent && state.notes[note.parent]) {
      const idx = state.notes[note.parent].children.indexOf(noteId);
      if (idx > -1) state.notes[note.parent].children.splice(idx, 1);
    }
    
    // Move note under DM
    note.parent = dmId;
    if (!dm.children) dm.children = [];
    if (!dm.children.includes(noteId)) {
      dm.children.push(noteId);
    }
    
    // Add users to the note AND all its children
    addUserToNoteTree(noteId, user.name);
    addUserToNoteTree(noteId, userName);
    
    console.log(`${user.name} shared note ${noteId} with ${userName}, moved under DM ${dmId}`);
    
    // Notify the sharer (update their view)
    const sharerDm = { ...dm, name: userName };
    socket.emit('noteShared', { 
      note: note, 
      dm: sharerDm 
    });
    
    // Notify the recipient - send DM, note, and all children
    const recipient = Array.from(state.users.values()).find(u => u.name === userName);
    if (recipient) {
      const recipientDm = { ...dm, name: user.name };
      io.to(recipient.id).emit('noteShared', { 
        note: note, 
        dm: recipientDm,
        fromUser: user.name
      });
      
      // Send all children of the shared note
      const allNotes = collectNoteTree(noteId);
      allNotes.forEach(n => {
        if (n.id !== noteId) {
          io.to(recipient.id).emit('noteInvite', {
            note: n,
            fromUser: user.name
          });
        }
      });
    }
  });
  
  // --------------------------------------------
  // INVITE TO NOTE
  // --------------------------------------------
  socket.on('inviteToNote', (data) => {
    const user = state.users.get(socket.id);
    if (!user) return;
    
    const { noteId, userName } = data;
    const note = state.notes[noteId];
    
    if (!note || note.isSpecial) return;
    
    // Add creator if not present
    if (note.creator && !note.users) {
      note.users = [];
    }
    if (note.creator && !note.users.includes(note.creator)) {
      note.users.push(note.creator);
    }
    
    // Add invited user to this note AND all nested children
    addUserToNoteTree(noteId, userName);
    
    // Count real users (non-agents)
    const realUsers = note.users.filter(u => {
      const isAgent = Object.values(state.bots).some(b => b.name === u);
      return !isAgent;
    });
    
    // Update note type - always 'dm' (shared note)
    // Name handling: 2 people = other person's name per user, 3+ = comma list
    note.type = 'dm';
    
    if (realUsers.length > 2) {
      // 3+ people - update name to comma list
      const otherMembers = realUsers.filter(u => u !== note.creator);
      note.name = otherMembers.slice(0, 3).join(', ') + (otherMembers.length > 3 ? '...' : '');
    }
    
    console.log(`${user.name} invited ${userName} to note ${noteId}, users: ${realUsers.length}, name: ${note.name}`);
    
    // Find invited user's socket
    let invitedSocketId = null;
    state.users.forEach((u, sid) => {
      if (u.name === userName) {
        invitedSocketId = sid;
      }
    });
    
    // Send note AND all children to invited user
    if (invitedSocketId) {
      let inviteeName = note.name;
      if (realUsers.length === 2) {
        // 2 people: invitee sees inviter's name
        inviteeName = user.name;
      } else {
        // 3+ people: show comma list excluding themselves
        const theirOthers = realUsers.filter(u => u !== userName);
        inviteeName = theirOthers.slice(0, 3).join(', ') + (theirOthers.length > 3 ? '...' : '');
      }
      
      // Check if invitee has access to the parent
      // If not, this note should appear top-level for them
      let noteForInvitee = { ...note, name: inviteeName };
      if (note.parent) {
        const parent = state.notes[note.parent];
        if (!parent || !parent.users || !parent.users.includes(userName)) {
          // Invitee doesn't have access to parent - make this top-level for them
          noteForInvitee.parent = null;
        }
      }
      
      // Send the main note
      io.to(invitedSocketId).emit('noteInvite', {
        note: noteForInvitee,
        fromUser: user.name
      });
      
      // Send all nested children
      const allNotes = collectNoteTree(noteId);
      allNotes.forEach(n => {
        if (n.id !== noteId) { // Skip the parent, already sent
          io.to(invitedSocketId).emit('noteInvite', {
            note: n,
            fromUser: user.name
          });
        }
      });
    }
    
    // Notify all users in note about changes
    const userIds = getUsersInNote(noteId);
    userIds.forEach(id => {
      if (id !== invitedSocketId) { // Don't double-send to invitee
        const viewingUser = state.users.get(id);
        let viewName = note.name;
        
        if (realUsers.length === 2 && viewingUser) {
          // 2 people: each sees the other's name
          const otherPerson = realUsers.find(u => u !== viewingUser.name);
          if (otherPerson) viewName = otherPerson;
        } else if (realUsers.length > 2 && viewingUser) {
          // 3+ people: each sees comma list excluding themselves
          const theirOthers = realUsers.filter(u => u !== viewingUser.name);
          viewName = theirOthers.slice(0, 3).join(', ') + (theirOthers.length > 3 ? '...' : '');
        }
        
        io.to(id).emit('noteTypeChanged', {
          noteId: noteId,
          type: note.type,
          name: viewName,
          users: note.users
        });
      }
    });
  });
  
  // --------------------------------------------
  // INVITE MULTIPLE USERS (batch invite)
  // --------------------------------------------
  socket.on('inviteMultiple', (data) => {
    const user = state.users.get(socket.id);
    if (!user) return;
    
    const { noteId, userNames } = data;
    const note = state.notes[noteId];
    
    if (!note || note.isSpecial || !userNames || userNames.length === 0) return;
    
    console.log(`${user.name} batch inviting ${userNames.join(', ')} to note ${noteId}`);
    
    // CASE 1: Already a shared note - just add users, DON'T rename
    if (note.type === 'dm') {
      // Add all invited users to this note AND all children
      userNames.forEach(userName => {
        addUserToNoteTree(noteId, userName);
      });
      
      // Count real users (non-agents)
      const realUsers = note.users.filter(u => {
        const isAgent = Object.values(state.bots).some(b => b.name === u);
        return !isAgent;
      });
      
      // Keep existing name - don't auto-rename
      // Send update to inviter (with their view - preserve their parent access)
      let noteForInviter = { ...note };
      if (note.parent) {
        const parent = state.notes[note.parent];
        if (!parent || !parent.users || !parent.users.includes(user.name)) {
          // Inviter doesn't have access to parent - keep it null for them
          noteForInviter.parent = null;
        }
      }
      socket.emit('inviteMultipleResult', { 
        note: noteForInviter
      });
      
      // Send to each invitee
      sendToInvitees(note, noteId, userNames, realUsers, user);
      
      // Notify existing users
      notifyExistingUsers(note, noteId, userNames, realUsers, user);
      return;
    }
    
    // CASE 2: Notebook + 1 person - check for existing DM
    if (note.type === 'notebook' && userNames.length === 1) {
      const inviteeName = userNames[0];
      
      // Look for existing 2-person DM with this person
      let existingDM = null;
      for (const [id, n] of Object.entries(state.notes)) {
        if (n.type === 'dm' && !n.isSpecial && !n.parent) {
          const noteUsers = n.users || [];
          if (noteUsers.length === 2 && noteUsers.includes(user.name) && noteUsers.includes(inviteeName)) {
            existingDM = n;
            break;
          }
        }
      }
      
      if (existingDM) {
        // NEST under existing DM
        // Remove from old parent
        if (note.parent && state.notes[note.parent]) {
          const idx = state.notes[note.parent].children.indexOf(noteId);
          if (idx > -1) state.notes[note.parent].children.splice(idx, 1);
        }
        
        // Move under DM
        note.parent = existingDM.id;
        note.type = 'dm';
        if (!existingDM.children) existingDM.children = [];
        if (!existingDM.children.includes(noteId)) {
          existingDM.children.push(noteId);
        }
        
        // Add users to note tree
        addUserToNoteTree(noteId, user.name);
        addUserToNoteTree(noteId, inviteeName);
        
        console.log(`Nested note ${noteId} under existing DM ${existingDM.id}`);
        
        // Send noteShared to inviter
        const sharerDm = { ...existingDM, name: inviteeName };
        socket.emit('noteShared', { 
          note: note, 
          dm: sharerDm 
        });
        
        // Send to invitee
        const recipient = Array.from(state.users.values()).find(u => u.name === inviteeName);
        if (recipient) {
          const recipientDm = { ...existingDM, name: user.name };
          io.to(recipient.id).emit('noteShared', { 
            note: note, 
            dm: recipientDm,
            fromUser: user.name
          });
          
          // Send children
          const allNotes = collectNoteTree(noteId);
          allNotes.forEach(n => {
            if (n.id !== noteId) {
              io.to(recipient.id).emit('noteInvite', {
                note: n,
                fromUser: user.name
              });
            }
          });
        }
        return;
      }
      
      // NO existing DM - convert this note to the DM
      // Remove from old parent
      if (note.parent && state.notes[note.parent]) {
        const idx = state.notes[note.parent].children.indexOf(noteId);
        if (idx > -1) state.notes[note.parent].children.splice(idx, 1);
      }
      
      note.type = 'dm';
      note.parent = null;
      note.name = inviteeName;
      note.creator = user.name;
      
      // Add users
      addUserToNoteTree(noteId, user.name);
      addUserToNoteTree(noteId, inviteeName);
      
      console.log(`Converted note ${noteId} to DM with ${inviteeName}`);
      
      // Send update to inviter
      socket.emit('inviteMultipleResult', { 
        note: { ...note, name: inviteeName }
      });
      
      // Send to invitee
      const recipient = Array.from(state.users.values()).find(u => u.name === inviteeName);
      if (recipient) {
        io.to(recipient.id).emit('noteInvite', {
          note: { ...note, name: user.name },
          fromUser: user.name
        });
        
        // Send children
        const allNotes = collectNoteTree(noteId);
        allNotes.forEach(n => {
          if (n.id !== noteId) {
            io.to(recipient.id).emit('noteInvite', {
              note: n,
              fromUser: user.name
            });
          }
        });
      }
      return;
    }
    
    // CASE 3: Notebook + 2+ people - convert to group
    // Remove from old parent (becomes top-level)
    if (note.parent && state.notes[note.parent]) {
      const parent = state.notes[note.parent];
      if (parent.type !== 'dm') {
        const idx = parent.children.indexOf(noteId);
        if (idx > -1) parent.children.splice(idx, 1);
        note.parent = null;
      }
    }
    
    note.type = 'dm';
    note.creator = user.name;
    
    // Add all users
    if (!note.users) note.users = [];
    if (!note.users.includes(user.name)) note.users.push(user.name);
    userNames.forEach(userName => {
      addUserToNoteTree(noteId, userName);
    });
    
    // Count real users
    const realUsers = note.users.filter(u => {
      const isAgent = Object.values(state.bots).some(b => b.name === u);
      return !isAgent;
    });
    
    // Set name (comma list of others for inviter)
    const inviterOthers = realUsers.filter(u => u !== user.name);
    const inviterName = inviterOthers.slice(0, 3).join(', ') + (inviterOthers.length > 3 ? '...' : '');
    note.name = inviterName;
    
    console.log(`Converted note ${noteId} to group with ${realUsers.join(', ')}`);
    
    // Send update to inviter
    socket.emit('inviteMultipleResult', { 
      note: { ...note, name: inviterName }
    });
    
    // Send to each invitee
    sendToInvitees(note, noteId, userNames, realUsers, user);
  });
  
  // Helper: Send note to invitees
  function sendToInvitees(note, noteId, userNames, realUsers, inviter) {
    userNames.forEach(userName => {
      const recipient = Array.from(state.users.values()).find(u => u.name === userName);
      if (!recipient) return;
      
      // Calculate name for this invitee
      const theirOthers = realUsers.filter(u => u !== userName);
      const theirName = theirOthers.length === 1
        ? theirOthers[0]
        : theirOthers.slice(0, 3).join(', ') + (theirOthers.length > 3 ? '...' : '');
      
      // Check if invitee has access to parent
      let noteForInvitee = { ...note, name: theirName };
      if (note.parent) {
        const parent = state.notes[note.parent];
        if (!parent || !parent.users || !parent.users.includes(userName)) {
          noteForInvitee.parent = null;
        }
      }
      
      io.to(recipient.id).emit('noteInvite', {
        note: noteForInvitee,
        fromUser: inviter.name
      });
      
      // Send children
      const allNotes = collectNoteTree(noteId);
      allNotes.forEach(n => {
        if (n.id !== noteId) {
          io.to(recipient.id).emit('noteInvite', {
            note: n,
            fromUser: inviter.name
          });
        }
      });
    });
  }
  
  // Helper: Notify existing users of changes
  function notifyExistingUsers(note, noteId, newUserNames, realUsers, inviter) {
    const existingUserNames = note.users.filter(u => u !== inviter.name && !newUserNames.includes(u));
    existingUserNames.forEach(userName => {
      const existingUser = Array.from(state.users.values()).find(u => u.name === userName);
      if (!existingUser) return;
      
      const theirOthers = realUsers.filter(u => u !== userName);
      const theirName = theirOthers.length === 1
        ? theirOthers[0]
        : theirOthers.slice(0, 3).join(', ') + (theirOthers.length > 3 ? '...' : '');
      
      io.to(existingUser.id).emit('noteTypeChanged', {
        noteId: noteId,
        type: note.type,
        name: theirName,
        users: note.users
      });
    });
  }
  
  // --------------------------------------------
  // CHAT MESSAGE
  // --------------------------------------------
  socket.on('message', (data) => {
    const user = state.users.get(socket.id);
    if (!user) return;
    
    const noteId = data.noteId || user.currentNote || 'cover';
    const note = state.notes[noteId];
    
    if (!note) {
      console.log(`Message to non-existent note: ${noteId}`);
      return;
    }
    
    const messageId = 'msg-' + (++messageIdCounter);
    const timeStr = getTimeString();
    
    const message = {
      id: messageId,
      noteId: noteId,
      author: user.name,
      authorType: user.type,
      text: data.text,
      time: timeStr,
      timestamp: Date.now(),
      replyTo: data.replyTo || null,
      quote: data.quote || null
    };
    
    // Store in note
    note.messages.push(message);
    
    // Track threads within note
    if (data.replyTo) {
      if (!note.threads[data.replyTo]) {
        note.threads[data.replyTo] = [];
      }
      note.threads[data.replyTo].push(messageId);
    }
    
    // Broadcast only to users who have access to this note
    const userIds = getUsersInNote(noteId);
    userIds.forEach(id => {
      io.to(id).emit('message', message);
    });
    
    console.log(`Message in ${noteId} from ${user.name}: ${data.text.substring(0, 50)}`);
    
    // Check for @mentions and trigger bot webhooks
    const mentions = data.text.match(/@[~\w-]+/g);
    if (mentions) {
      mentions.forEach(mention => {
        const botName = mention.slice(1);
        // Find bot by name
        Object.values(state.bots).forEach(bot => {
          if (bot.name === botName && bot.webhookUrl) {
            console.log(`Triggering webhook for ${bot.name}`);
            triggerWebhook(bot, message);
          }
        });
      });
    }
  });
  
  // --------------------------------------------
  // ARTIFACT CREATE
  // --------------------------------------------
  socket.on('createArtifact', (data) => {
    const user = state.users.get(socket.id);
    if (!user) return;
    
    const artifactId = 'artifact-' + (++artifactIdCounter);
    const timeStr = getTimeString();
    
    const noteId = user.currentNote || 'cover';
    const note = state.notes[noteId];
    
    const artifact = {
      id: artifactId,
      name: data.name,
      type: data.type,
      creator: user.name,
      creatorType: user.type,
      noteId: noteId,
      contributors: [],
      versions: [{
        version: 1,
        content: data.content,
        modified: timeStr,
        editor: user.name,
        editorType: user.type
      }]
    };
    
    state.artifacts[artifactId] = artifact;
    
    // Broadcast to all clients in this note
    const userIds = getUsersInNote(noteId);
    userIds.forEach(id => {
      io.to(id).emit('artifactCreated', artifact);
    });
    
    // Also post a message about it (include comment if provided)
    const messageId = 'msg-' + (++messageIdCounter);
    const messageText = data.comment ? data.comment : `created artifact: ${data.name}`;
    const message = {
      id: messageId,
      noteId: noteId,
      author: user.name,
      authorType: user.type,
      text: messageText,
      time: timeStr,
      timestamp: Date.now(),
      artifactId: artifactId,
      artifactVersion: 1
    };
    
    if (note) {
      note.messages.push(message);
    }
    
    userIds.forEach(id => {
      io.to(id).emit('message', message);
    });
  });
  
  // --------------------------------------------
  // ARTIFACT EDIT
  // --------------------------------------------
  socket.on('editArtifact', (data) => {
    const user = state.users.get(socket.id);
    if (!user) return;
    
    const artifact = state.artifacts[data.artifactId];
    if (!artifact) return;
    
    const timeStr = getTimeString();
    const newVersion = artifact.versions.length + 1;
    const noteId = user.currentNote || 'cover';
    const note = state.notes[noteId];
    
    artifact.versions.push({
      version: newVersion,
      content: data.content,
      modified: timeStr,
      editor: user.name,
      editorType: user.type
    });
    
    // Add to contributors if not already
    if (!artifact.contributors.includes(user.name) && artifact.creator !== user.name) {
      artifact.contributors.push(user.name);
    }
    
    // Broadcast update to users in note
    const userIds = getUsersInNote(noteId);
    userIds.forEach(id => {
      io.to(id).emit('artifactUpdated', artifact);
    });
    
    // Post message about edit
    const messageId = 'msg-' + (++messageIdCounter);
    const message = {
      id: messageId,
      noteId: noteId,
      author: user.name,
      authorType: user.type,
      text: `edited artifact: ${artifact.name}`,
      time: timeStr,
      timestamp: Date.now(),
      artifactId: artifact.id,
      artifactVersion: newVersion
    };
    
    if (note) {
      note.messages.push(message);
    }
    
    userIds.forEach(id => {
      io.to(id).emit('message', message);
    });
  });
  
  // --------------------------------------------
  // WALLET - SEND NOCK
  // --------------------------------------------
  socket.on('sendNock', (data) => {
    const user = state.users.get(socket.id);
    if (!user) {
      console.log('sendNock: No user found for socket', socket.id);
      return;
    }
    
    const { to, amount, replyToMessageId } = data;
    console.log(`sendNock: ${user.name} sending ${amount} to ${to}`);
    
    const wallet = state.wallets[socket.id];
    
    if (!wallet || wallet.balance < amount) {
      console.log('sendNock: Insufficient balance or no wallet');
      socket.emit('error', { message: 'Insufficient balance' });
      return;
    }
    
    const timeStr = getTimeString();
    
    // Deduct from sender
    wallet.balance -= amount;
    wallet.transactions.push({
      type: 'sent',
      who: to,
      amount,
      time: timeStr
    });
    console.log(`sendNock: Deducted from ${user.name}, new balance: ${wallet.balance}`);
    
    // Find recipient and add to their wallet
    const recipient = Array.from(state.users.values()).find(u => u.name === to);
    console.log('sendNock: Looking for recipient:', to, 'Found:', recipient ? recipient.name : 'NOT FOUND');
    
    if (recipient) {
      const recipientWallet = initWallet(recipient.id);
      recipientWallet.balance += amount;
      recipientWallet.transactions.push({
        type: 'received',
        who: user.name,
        amount,
        time: timeStr
      });
      console.log(`sendNock: Added to ${recipient.name}, new balance: ${recipientWallet.balance}`);
      
      // Notify recipient of wallet update
      io.to(recipient.id).emit('walletUpdate', recipientWallet);
    }
    
    // Notify sender of wallet update
    socket.emit('walletUpdate', wallet);
    console.log('sendNock: Sent walletUpdate to sender');
    
    // If this is a reply (hover SEND), keep in current note and thread
    if (replyToMessageId) {
      const noteId = user.currentNote || 'cover';
      const note = state.notes[noteId];
      
      const messageId = 'msg-' + (++messageIdCounter);
      const message = {
        id: messageId,
        noteId: noteId,
        author: user.name,
        authorType: user.type,
        text: `sent ${amount.toFixed(2)} $NOCK`,
        time: timeStr,
        timestamp: Date.now(),
        isNockSend: true,
        replyTo: replyToMessageId
      };
      
      if (note) {
        note.messages.push(message);
        if (!note.threads) note.threads = {};
        if (!note.threads[replyToMessageId]) {
          note.threads[replyToMessageId] = [];
        }
        note.threads[replyToMessageId].push(messageId);
      }
      
      const userIds = getUsersInNote(noteId);
      userIds.forEach(id => {
        io.to(id).emit('message', message);
      });
    } else {
      // Wallet modal SEND - goes to 2-person DM only (not groups)
      let dmNote = null;
      let dmNoteId = null;
      
      for (const [id, note] of Object.entries(state.notes)) {
        // Only match top-level DMs with exactly 2 users
        if (note.type === 'dm' && !note.isSpecial && !note.parent) {
          const noteUsers = note.users || [];
          // Must have exactly 2 users and include both sender and recipient
          if (noteUsers.length === 2 && noteUsers.includes(user.name) && noteUsers.includes(to)) {
            dmNote = note;
            dmNoteId = id;
            break;
          }
        }
      }
      
      // If no DM exists, create one
      if (!dmNote) {
        dmNoteId = 'note-' + (++noteIdCounter);
        dmNote = {
          id: dmNoteId,
          name: to,
          type: 'dm',
          creator: user.name,
          users: [user.name, to],
          messages: [],
          threads: {},
          children: [],
          parent: null,
          visibility: 'private',
          writable: true
        };
        state.notes[dmNoteId] = dmNote;
        
        // Notify sender about the new DM
        socket.emit('noteInvite', { note: dmNote, fromUser: to });
        
        // Notify recipient about the new DM (with their perspective on naming)
        if (recipient) {
          const recipientNote = { ...dmNote, name: user.name };
          io.to(recipient.id).emit('noteInvite', { note: recipientNote, fromUser: user.name });
        }
      }
      
      // Post message to DM
      const messageId = 'msg-' + (++messageIdCounter);
      const message = {
        id: messageId,
        noteId: dmNoteId,
        author: user.name,
        authorType: user.type,
        text: `sent ${amount.toFixed(2)} $NOCK`,
        time: timeStr,
        timestamp: Date.now(),
        isNockSend: true
      };
      
      dmNote.messages.push(message);
      
      // Send to both users in the DM
      const userIds = getUsersInNote(dmNoteId);
      userIds.forEach(id => {
        io.to(id).emit('message', message);
      });
    }
  });
  
  // --------------------------------------------
  // WALLET - REQUEST NOCK
  // --------------------------------------------
  socket.on('requestNock', (data) => {
    const user = state.users.get(socket.id);
    if (!user) return;
    
    const { from, amount } = data;
    const timeStr = getTimeString();
    
    // Find existing top-level 2-person DM with this person or create one
    let dmNote = null;
    let dmNoteId = null;
    
    for (const [id, note] of Object.entries(state.notes)) {
      // Only match top-level DMs with exactly 2 users
      if (note.type === 'dm' && !note.isSpecial && !note.parent) {
        const noteUsers = note.users || [];
        // Must have exactly 2 users and include both parties
        if (noteUsers.length === 2 && noteUsers.includes(user.name) && noteUsers.includes(from)) {
          dmNote = note;
          dmNoteId = id;
          break;
        }
      }
    }
    
    // If no DM exists, create one
    if (!dmNote) {
      dmNoteId = 'note-' + (++noteIdCounter);
      dmNote = {
        id: dmNoteId,
        name: from, // Named after the other person from requester's perspective
        type: 'dm',
        creator: user.name,
        users: [user.name, from],
        messages: [],
        threads: {},
        children: [],
        parent: null,
        visibility: 'private',
        writable: true
      };
      state.notes[dmNoteId] = dmNote;
      
      // Notify both users about the new DM
      socket.emit('noteInvite', { note: dmNote, fromUser: from });
      
      const recipient = Array.from(state.users.values()).find(u => u.name === from);
      if (recipient) {
        const recipientNote = { ...dmNote, name: user.name }; // Named after requester for recipient
        io.to(recipient.id).emit('noteInvite', { note: recipientNote, fromUser: user.name });
      }
    }
    
    const messageId = 'msg-' + (++messageIdCounter);
    const message = {
      id: messageId,
      noteId: dmNoteId,
      author: user.name,
      authorType: user.type,
      text: `requesting ${amount.toFixed(2)} $NOCK`,
      time: timeStr,
      timestamp: Date.now(),
      isNockRequest: true
    };
    
    dmNote.messages.push(message);
    
    // Send to both users in the DM
    const userIds = getUsersInNote(dmNoteId);
    userIds.forEach(id => {
      io.to(id).emit('message', message);
    });
  });
  
  // --------------------------------------------
  // BOT WEBHOOK REGISTRATION
  // --------------------------------------------
  socket.on('registerBot', (data) => {
    const user = state.users.get(socket.id);
    if (!user) return;
    
    state.bots[socket.id] = {
      id: socket.id,
      name: data.name,
      webhookUrl: data.webhookUrl,
      owner: user.name
    };
    
    console.log(`Bot registered: ${data.name} -> ${data.webhookUrl} (owner: ${user.name})`);
    socket.emit('botRegistered', { success: true, name: data.name, owner: user.name });
    
    // Broadcast updated agents list to all users (with owner info)
    const agentList = Object.values(state.bots).map(b => ({ name: b.name, owner: b.owner }));
    io.emit('agentsList', agentList);
  });
  
  // --------------------------------------------
  // DISCONNECT
  // --------------------------------------------
  socket.on('disconnect', () => {
    const user = state.users.get(socket.id);
    if (user) {
      console.log(`User left: ${user.name}`);
      socket.broadcast.emit('userLeft', { name: user.name });
    }
    
    state.users.delete(socket.id);
    delete state.bots[socket.id];
    
    broadcastUserList();
  });
});

// ============================================
// BOT WEBHOOK TRIGGER
// ============================================

async function triggerWebhook(bot, message) {
  try {
    const response = await fetch(bot.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'mention',
        message: message,
        botName: bot.name,
        // Include context the bot might need
        artifacts: state.artifacts,
        users: Array.from(state.users.values()).map(u => ({ name: u.name, type: u.type }))
      })
    });
    
    if (response.ok) {
      const data = await response.json();
      
      // Handle text reply
      if (data.reply) {
        const messageId = 'msg-' + (++messageIdCounter);
        const timeStr = getTimeString();
        
        // Get the note the original message was in
        const noteId = message.noteId || 'cover';
        const note = state.notes[noteId];
        
        const botMessage = {
          id: messageId,
          noteId: noteId,
          author: bot.name,
          authorType: 'agent',
          text: data.reply,
          time: timeStr,
          timestamp: Date.now(),
          replyTo: message.id
        };
        
        // Store in note
        if (note) {
          note.messages.push(botMessage);
          
          if (!note.threads) {
            note.threads = {};
          }
          if (!note.threads[message.id]) {
            note.threads[message.id] = [];
          }
          note.threads[message.id].push(messageId);
        }
        
        // Broadcast to users in the note
        const userIds = getUsersInNote(noteId);
        userIds.forEach(id => {
          io.to(id).emit('message', botMessage);
        });
      }
      
      // Handle actions
      if (data.actions && Array.isArray(data.actions)) {
        for (const action of data.actions) {
          await executeAction(bot, action, message);
        }
      }
    }
  } catch (err) {
    console.error(`Webhook error for ${bot.name}:`, err.message);
  }
}

async function executeAction(bot, action, triggerMessage) {
  const timeStr = getTimeString();
  const noteId = triggerMessage.noteId || 'cover';
  const note = state.notes[noteId];
  
  switch (action.type) {
    case 'createArtifact': {
      const artifactId = 'artifact-' + (++artifactIdCounter);
      
      const artifact = {
        id: artifactId,
        name: action.name || 'untitled',
        type: action.artifactType || 'markdown',
        creator: bot.name,
        creatorType: 'agent',
        noteId: noteId,
        contributors: [],
        versions: [{
          version: 1,
          content: action.content || '',
          modified: timeStr,
          editor: bot.name,
          editorType: 'agent'
        }]
      };
      
      state.artifacts[artifactId] = artifact;
      
      const userIds = getUsersInNote(noteId);
      userIds.forEach(id => {
        io.to(id).emit('artifactCreated', artifact);
      });
      
      // Post message about artifact creation
      const messageId = 'msg-' + (++messageIdCounter);
      const msg = {
        id: messageId,
        noteId: noteId,
        author: bot.name,
        authorType: 'agent',
        text: `created artifact: ${artifact.name}`,
        time: timeStr,
        timestamp: Date.now(),
        artifactId: artifactId,
        artifactVersion: 1
      };
      
      if (note) note.messages.push(msg);
      userIds.forEach(id => {
        io.to(id).emit('message', msg);
      });
      
      console.log(`Bot ${bot.name} created artifact: ${artifact.name}`);
      break;
    }
    
    case 'editArtifact': {
      const artifact = state.artifacts[action.artifactId];
      if (!artifact) {
        console.log(`Bot ${bot.name} tried to edit non-existent artifact: ${action.artifactId}`);
        break;
      }
      
      const newVersion = artifact.versions.length + 1;
      artifact.versions.push({
        version: newVersion,
        content: action.content,
        modified: timeStr,
        editor: bot.name,
        editorType: 'agent'
      });
      
      if (!artifact.contributors.includes(bot.name)) {
        artifact.contributors.push(bot.name);
      }
      
      const userIds = getUsersInNote(noteId);
      userIds.forEach(id => {
        io.to(id).emit('artifactUpdated', artifact);
      });
      
      // Post message about edit
      const messageId = 'msg-' + (++messageIdCounter);
      const msg = {
        id: messageId,
        noteId: noteId,
        author: bot.name,
        authorType: 'agent',
        text: `edited artifact: ${artifact.name}`,
        time: timeStr,
        timestamp: Date.now(),
        artifactId: artifact.id,
        artifactVersion: newVersion
      };
      
      if (note) note.messages.push(msg);
      userIds.forEach(id => {
        io.to(id).emit('message', msg);
      });
      
      console.log(`Bot ${bot.name} edited artifact: ${artifact.name} (v${newVersion})`);
      break;
    }
    
    case 'sendNock': {
      const recipient = Array.from(state.users.values()).find(u => u.name === action.to);
      if (!recipient) {
        console.log(`Bot ${bot.name} tried to send NOCK to non-existent user: ${action.to}`);
        break;
      }
      
      const recipientWallet = initWallet(recipient.id);
      recipientWallet.balance += action.amount;
      recipientWallet.transactions.push({
        type: 'received',
        who: bot.name,
        amount: action.amount,
        time: timeStr
      });
      
      io.to(recipient.id).emit('walletUpdate', recipientWallet);
      
      // Post message about transfer
      const messageId = 'msg-' + (++messageIdCounter);
      const msg = {
        id: messageId,
        noteId: noteId,
        author: bot.name,
        authorType: 'agent',
        text: `sent ${action.amount.toFixed(2)} $NOCK to ${action.to}`,
        time: timeStr,
        timestamp: Date.now(),
        isNockSend: true
      };
      
      if (note) note.messages.push(msg);
      const userIds = getUsersInNote(noteId);
      userIds.forEach(id => {
        io.to(id).emit('message', msg);
      });
      
      console.log(`Bot ${bot.name} sent ${action.amount} NOCK to ${action.to}`);
      break;
    }
    
    case 'message': {
      const messageId = 'msg-' + (++messageIdCounter);
      const msg = {
        id: messageId,
        noteId: noteId,
        author: bot.name,
        authorType: 'agent',
        text: action.text,
        time: timeStr,
        timestamp: Date.now(),
        replyTo: action.replyTo || null
      };
      
      if (note) {
        note.messages.push(msg);
        if (action.replyTo) {
          if (!note.threads) note.threads = {};
          if (!note.threads[action.replyTo]) {
            note.threads[action.replyTo] = [];
          }
          note.threads[action.replyTo].push(messageId);
        }
      }
      
      const userIds = getUsersInNote(noteId);
      userIds.forEach(id => {
        io.to(id).emit('message', msg);
      });
      
      console.log(`Bot ${bot.name} sent message: ${action.text}`);
      break;
    }
    
    default:
      console.log(`Bot ${bot.name} tried unknown action: ${action.type}`);
  }
}

// ============================================
// HTTP ROUTES
// ============================================

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', users: state.users.size });
});

// Bot webhook endpoint (for external bots to post messages)
app.post('/api/bot/message', (req, res) => {
  const { botName, text, apiKey, noteId = 'cover' } = req.body;
  
  // Find bot by name
  const bot = Object.values(state.bots).find(b => b.name === botName);
  
  if (!bot) {
    return res.status(404).json({ error: 'Bot not found' });
  }
  
  const note = state.notes[noteId];
  if (!note) {
    return res.status(404).json({ error: 'Note not found' });
  }
  
  const messageId = 'msg-' + (++messageIdCounter);
  const timeStr = getTimeString();
  
  const message = {
    id: messageId,
    noteId: noteId,
    author: botName,
    authorType: 'agent',
    text,
    time: timeStr,
    timestamp: Date.now()
  };
  
  note.messages.push(message);
  
  const userIds = getUsersInNote(noteId);
  userIds.forEach(id => {
    io.to(id).emit('message', message);
  });
  
  res.json({ success: true, messageId });
});

// ============================================
// START SERVER
// ============================================

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════╗
║         GRIMOIRE SERVER                ║
║                                        ║
║   Running on http://localhost:${PORT}    ║
║                                        ║
║   Open in multiple browser tabs        ║
║   to test multi-user chat!             ║
╚════════════════════════════════════════╝
  `);
});
