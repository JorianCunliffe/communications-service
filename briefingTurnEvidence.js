// Call-local evidence. The readback belongs to the caller turn that answered it,
// not whichever acknowledgement the assistant happens to generate afterwards.
export function createBriefingTurnEvidence() {
    const items=new Map(), marks=new Map(), humans=new Map(), waiters=new Set();
    let latest=null, currentHuman=null, sequence=0;
    const item=id=>{
        if(!id)return null;
        if(!items.has(id))items.set(id,{id,startedAt:null,text:null,done:false,pending:new Set(),playedAt:null,interrupted:false});
        if(items.size>512){for(const [key,value] of items){if(value!==latest&&value!==currentHuman?.candidate?.item&&!value.pending.size){items.delete(key);break;}}}
        return items.get(id);
    };
    const fullyPlayed=value=>Boolean(value?.done&&!value.interrupted&&!value.pending.size&&value.playedAt!==null);
    const evidence=(turn=currentHuman)=>{
        const readback=turn?.candidate;
        return {
            human:turn?.complete&&turn.text?{text:turn.text,at:turn.at,observedAt:turn.observedAt,itemId:turn.itemId}:null,
            assistant:readback?.eligible&&readback.item.text&&!readback.item.interrupted?{
                text:readback.item.text,at:readback.item.startedAt,itemId:readback.item.id,
                playedAt:readback.playedAt,interrupted:false,
            }:null,
        };
    };
    const notify=()=>{for(const done of [...waiters])done();};
    return {
        audio(id,at=Date.now()) {const value=item(id);if(!value)return;if(value.done)value.interrupted=true;value.startedAt??=at;latest=value;},
        transcript(id,text) {const value=item(id);if(value)value.text=text;},
        audioDone(id) {const value=item(id);if(value)value.done=true;},
        markSent(name,id) {const value=item(id);if(value){marks.set(name,value);value.pending.add(name);}},
        markPlayed(name,at=Date.now()) {const value=marks.get(name);if(value){marks.delete(name);value.pending.delete(name);value.playedAt=at;}},
        humanStarted(at=Date.now()) {
            const eligible=fullyPlayed(latest)&&at>latest.playedAt;
            currentHuman={sequence:++sequence,at,candidate:latest?{item:latest,eligible,playedAt:latest.playedAt}:null,complete:false};
            if(latest&&!eligible)latest.interrupted=true;
            // A barge-in clears queued audio, but its later mark echoes cannot
            // establish that the discarded readback played in full.
            for(const value of marks.values()){value.interrupted=true;value.pending.clear();}
            marks.clear();
        },
        humanCommitted(id) {if(currentHuman){currentHuman.itemId=id;humans.set(id,currentHuman);if(humans.size>128)humans.delete(humans.keys().next().value);}},
        humanTranscript(id,text,at=Date.now()) {const turn=humans.get(id);if(!turn)return;turn.text=text;turn.observedAt=at;turn.complete=true;notify();},
        humanFailed(id) {const turn=humans.get(id);if(turn){turn.complete=true;turn.text=null;notify();}},
        evidence,
        async waitForHuman(timeoutMs=3000) {
            const turn=currentHuman;
            if(!turn||turn.complete)return evidence(turn);
            await new Promise(resolve=>{
                const done=(forced=false)=>{if(!forced&&!turn.complete)return;clearTimeout(timer);waiters.delete(done);resolve();};
                const timer=setTimeout(()=>done(true),timeoutMs);waiters.add(done);
            });
            return evidence(turn);
        },
        close() {for(const done of [...waiters])done(true);},
    };
}
