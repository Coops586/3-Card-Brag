const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const rooms = new Map();
const suits = ['S','H','D','C'];
const ranks = [2,3,4,5,6,7,8,9,10,11,12,13,14];

function freshDeck(){
  const d=[];
  for(const s of suits) for(const r of ranks) d.push({s,r});
  for(let i=d.length-1;i>0;i--){
    const j=Math.floor(Math.random()*(i+1));
    [d[i],d[j]]=[d[j],d[i]];
  }
  return d;
}
function makeCode(){
  const chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c='';
  for(let i=0;i<5;i++) c+=chars[Math.floor(Math.random()*chars.length)];
  return c;
}
function evaluate(hand){
  const rs=hand.map(c=>c.r).sort((a,b)=>b-a);
  const counts={}; rs.forEach(r=>counts[r]=(counts[r]||0)+1);
  const flush=hand.every(c=>c.s===hand[0].s);
  const uniq=[...new Set(rs)];
  let runHigh=0;
  if(uniq.length===3){
    if(uniq.includes(14)&&uniq.includes(2)&&uniq.includes(3)) runHigh=15;
    else if(uniq.includes(14)&&uniq.includes(13)&&uniq.includes(12)) runHigh=14.5;
    else if(uniq[0]-uniq[2]===2) runHigh=uniq[0];
  }
  const trip=Object.keys(counts).find(r=>counts[r]===3);
  const pair=Object.keys(counts).find(r=>counts[r]===2);
  if(trip){ const t=+trip; return {score:[6,t===3?15:t],label:`Prial of ${nameRank(t)}s`}; }
  if(runHigh&&flush) return {score:[5,runHigh],label:'Running flush'};
  if(runHigh) return {score:[4,runHigh],label:'Run'};
  if(flush) return {score:[3,...rs],label:'Flush'};
  if(pair){ const p=+pair,k=rs.find(r=>r!==p); return {score:[2,p,k],label:`Pair of ${nameRank(p)}s`}; }
  return {score:[1,...rs],label:`${nameRank(rs[0])}-high`};
}
function nameRank(r){ return ({11:'J',12:'Q',13:'K',14:'A'}[r]||String(r)); }
function cmp(a,b){
  for(let i=0;i<Math.max(a.length,b.length);i++){
    const x=a[i]||0,y=b[i]||0;
    if(x!==y) return x-y;
  }
  return 0;
}
function activeIndexes(room){
  return room.players.map((p,i)=>p.lives>0?i:-1).filter(i=>i>=0);
}
function nextActive(room, from){
  let i=from;
  do i=(i+1)%room.players.length; while(room.players[i].lives<=0);
  return i;
}
function deal(room){
  room.deck=freshDeck();
  room.middle=room.deck.splice(0,3);
  activeIndexes(room).forEach(i=>{
    room.players[i].hand=room.deck.splice(0,3);
    room.players[i].swappedThisTurn=false;
  });
  room.current=activeIndexes(room)[0];
  room.knockedBy=null;
  room.turnsAfterKnock=0;
  room.round=(room.round||0)+1;
  room.status='playing';
  room.lastResult=null;
}
function publicState(room){
  return {
    code:room.code,
    hostId:room.hostId,
    players:room.players.map((p,i)=>({
      name:p.name,lives:p.lives,index:i,connected:p.connected,
      wins:p.wins||0,avatar:p.avatar||'🂠'
    })),
    middle:room.middle,
    current:room.current,
    knockedBy:room.knockedBy,
    round:room.round,
    status:room.status,
    settings:room.settings,
    lastResult:room.lastResult
  };
}
function emitRoom(room){
  io.to(room.code).emit('roomState', publicState(room));
  room.players.forEach((p,i)=>{
    if(p.socketId) io.to(p.socketId).emit('privateHand',{
      hand:p.hand||[], yourIndex:i, handLabel:(p.hand&&p.hand.length===3)?evaluate(p.hand).label:''
    });
  });
}

io.on('connection', socket=>{
  socket.on('createRoom', ({name,lives=3,avatar='🂠'})=>{
    let c; do c=makeCode(); while(rooms.has(c));
    const room={
      code:c,hostId:socket.id,status:'lobby',round:0,middle:[],
      settings:{lives:Number(lives)||3,maxPlayers:6},
      players:[{name:name||'Player 1',lives:Number(lives)||3,socketId:socket.id,connected:true,hand:[],wins:0,avatar}]
    };
    rooms.set(c,room);
    socket.join(c); socket.data.room=c;
    socket.emit('joined',{code:c,yourIndex:0});
    emitRoom(room);
  });

  socket.on('joinRoom', ({code,name,avatar='🂠'})=>{
    const c=(code||'').toUpperCase().trim();
    const room=rooms.get(c);
    if(!room) return socket.emit('errorMsg','Room not found.');
    if(room.status!=='lobby') return socket.emit('errorMsg','Game already started.');
    if(room.players.length>=room.settings.maxPlayers) return socket.emit('errorMsg','Room is full.');
    const i=room.players.length;
    room.players.push({
      name:name||`Player ${i+1}`,lives:room.settings.lives,socketId:socket.id,
      connected:true,hand:[],wins:0,avatar
    });
    socket.join(c); socket.data.room=c;
    socket.emit('joined',{code:c,yourIndex:i});
    emitRoom(room);
  });

  socket.on('startGame', ()=>{
    const room=rooms.get(socket.data.room);
    if(!room || room.hostId!==socket.id) return;
    if(room.players.length<2) return socket.emit('errorMsg','Need at least 2 players.');
    room.players.forEach(p=>p.lives=room.settings.lives);
    deal(room); emitRoom(room);
  });

  socket.on('swap', ({mine,middle})=>{
    const room=rooms.get(socket.data.room);
    if(!room || room.status!=='playing') return;
    const pi=room.players.findIndex(p=>p.socketId===socket.id);
    if(pi!==room.current) return socket.emit('errorMsg','Not your turn.');
    const p=room.players[pi];
    if(p.swappedThisTurn) return socket.emit('errorMsg','You have already swapped this turn.');
    if(!Array.isArray(mine)||!Array.isArray(middle)||mine.length!==middle.length||![1,3].includes(mine.length)) return;
    if(new Set(mine).size!==mine.length || new Set(middle).size!==middle.length) return;
    for(let k=0;k<mine.length;k++){
      const a=mine[k], b=middle[k];
      if(a<0||a>2||b<0||b>2) return;
      const tmp=p.hand[a]; p.hand[a]=room.middle[b]; room.middle[b]=tmp;
    }
    p.swappedThisTurn=true;
    io.to(room.code).emit('fx',{type:'swap',player:pi});
    emitRoom(room);
  });

  socket.on('knock', ()=>{
    const room=rooms.get(socket.data.room);
    if(!room||room.status!=='playing') return;
    const pi=room.players.findIndex(p=>p.socketId===socket.id);
    if(pi!==room.current || room.knockedBy!==null) return;
    room.knockedBy=pi; room.turnsAfterKnock=0;
    io.to(room.code).emit('fx',{type:'knock',player:pi});
    emitRoom(room);
  });

  socket.on('finishTurn', ()=>{
    const room=rooms.get(socket.data.room);
    if(!room||room.status!=='playing') return;
    const pi=room.players.findIndex(p=>p.socketId===socket.id);
    if(pi!==room.current) return;

    if(room.knockedBy!==null && pi!==room.knockedBy) room.turnsAfterKnock++;
    const needed=activeIndexes(room).length-1;
    if(room.knockedBy!==null && room.turnsAfterKnock>=needed){
      const alive=activeIndexes(room).map(i=>({i,e:evaluate(room.players[i].hand)}));
      let weakest=alive[0].e.score;
      alive.forEach(x=>{ if(cmp(x.e.score,weakest)<0) weakest=x.e.score; });
      const losers=alive.filter(x=>cmp(x.e.score,weakest)===0).map(x=>x.i);
      losers.forEach(i=>room.players[i].lives--);
      const remaining=activeIndexes(room);
      if(remaining.length===1){
        room.players[remaining[0]].wins=(room.players[remaining[0]].wins||0)+1;
        room.status='finished';
      } else room.status='roundEnd';

      room.lastResult={
        losers,
        hands: room.players.map((p,i)=>({i,name:p.name,hand:p.hand,lives:p.lives,label:evaluate(p.hand).label}))
      };
      io.to(room.code).emit('roundResult',room.lastResult);
      emitRoom(room);
      return;
    }

    room.players[pi].swappedThisTurn=false;
    room.current=nextActive(room,room.current);
    emitRoom(room);
  });

  socket.on('nextRound', ()=>{
    const room=rooms.get(socket.data.room);
    if(!room || room.hostId!==socket.id || room.status!=='roundEnd') return;
    deal(room); emitRoom(room);
  });

  socket.on('rematch', ()=>{
    const room=rooms.get(socket.data.room);
    if(!room || room.hostId!==socket.id) return;
    room.players.forEach(p=>p.lives=room.settings.lives);
    room.round=0;
    deal(room); emitRoom(room);
  });

  socket.on('disconnect', ()=>{
    const room=rooms.get(socket.data.room);
    if(!room) return;
    const p=room.players.find(p=>p.socketId===socket.id);
    if(p) p.connected=false;
    if(room.players.every(p=>!p.connected)) rooms.delete(room.code);
    else emitRoom(room);
  });
});

const PORT=process.env.PORT||3000;
server.listen(PORT,()=>console.log(`Bastard Brag running on port ${PORT}`));
