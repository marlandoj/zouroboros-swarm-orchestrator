# Solutions for Long-Running Swarm Operations (>15 min)

## The Problem

Zo's chat interface times out after ~15 minutes of inactivity. For long swarm campaigns:
- The orchestrator continues running in the background
- Results are saved to `~/.swarm/results/*.json`
- BUT the chat window never sees the output
- User loses visibility into what happened

## Solution 1: Background + Notification (Recommended) ✅

**Use the built-in `--notify` flag** to get results delivered when complete.

```bash
# Run in background with SMS notification
nohup bun /home/workspace/Skills/zo-swarm-orchestrator/scripts/orchestrate-v4.ts campaign.json \
  --notify sms \
  > /tmp/swarm.log 2>&1 &

# Or email notification
nohup bun /home/workspace/Skills/zo-swarm-orchestrator/scripts/orchestrate-v4.ts campaign.json \
  --notify email \
  > /tmp/swarm.log 2>&1 &
```

**What happens:**
1. Swarm runs in background (survives chat timeout)
2. Results saved to `~/.swarm/results/`
3. When complete, you get notified via SMS/email with:
   - Success/failure summary
   - Duration
   - Path to detailed results file

**Pros:**
- ✅ Already implemented
- ✅ Decouples execution from chat session
- ✅ User gets notified when done
- ✅ Can go do other things while it runs

**Cons:**
- ⚠️ No real-time progress visibility
- ⚠️ Can't intervene if something goes wrong

---

## Solution 2: Progress File + Polling Agent 🤖

Create a scheduled agent that monitors swarm progress and sends periodic updates.

**Implementation:**

### Step 1: Enhance orchestrator to write progress file

```typescript
// Add to SwarmOrchestrator class
private writeProgress(completed: number, total: number, currentTask?: string) {
  const progressFile = join(this.swarmDir, "logs", `${this.swarmId}_progress.json`);
  writeFileSync(progressFile, JSON.stringify({
    swarmId: this.swarmId,
    completed,
    total,
    currentTask,
    timestamp: Date.now(),
    percentComplete: Math.round((completed / total) * 100)
  }));
}
```

### Step 2: Create progress monitor agent

```bash
# Create agent that checks every 5 minutes
bun /home/workspace/Skills/zo-swarm-orchestrator/scripts/create-monitor-agent.ts \
  --swarm-id <id> \
  --interval "*/5 * * * *" \
  --notify sms
```

**Agent logic:**
- Every 5 minutes, read `~/.swarm/logs/{swarm-id}_progress.json`
- If progress changed, send update: "Swarm: 8/20 tasks complete (40%)"
- When 100%, send final summary + results path

**Pros:**
- ✅ Get periodic updates
- ✅ Know it's still running
- ✅ Can catch stuck/failed swarms early

**Cons:**
- ⚠️ Requires orchestrator code change
- ⚠️ More SMS/email spam

---

## Solution 3: Streaming Results via Agent API 🌊

For campaigns where you need **real-time** feedback in chat, use a hybrid approach:

```typescript
// Instead of one long swarm call, orchestrate via parent agent
async function runLongSwarmWithStreaming(campaignPath: string) {
  // 1. Start swarm in background
  const swarmId = randomUUID();
  const proc = spawn("bun", [
    "orchestrate-v4.ts", 
    campaignPath,
    "--swarm-id", swarmId,
    "--notify", "email"
  ], { detached: true });
  
  proc.unref(); // Let it run independently
  
  console.log(`✅ Swarm ${swarmId} started in background`);
  console.log(`📊 Monitor progress: bun orchestrate-v4.ts status ${swarmId}`);
  console.log(`📧 You'll be emailed when complete`);
  
  // 2. Poll for updates every 2 minutes for first 14 minutes
  for (let i = 0; i < 7; i++) {
    await sleep(120_000); // 2 min
    
    const status = await getSwarmStatus(swarmId);
    if (status.complete) {
      return status.results;
    }
    
    console.log(`[${i*2}m] Progress: ${status.completed}/${status.total} tasks`);
  }
  
  // 3. After 14 min, hand off to notification
  console.log(`⏰ Swarm still running. Switching to background mode.`);
  console.log(`📧 You'll be emailed when complete at: ${results.path}`);
  
  return { backgroundMode: true, swarmId, monitorCommand: `bun orchestrate-v4.ts status ${swarmId}` };
}
```

**Pros:**
- ✅ Get updates while in chat
- ✅ Graceful handoff when approaching timeout
- ✅ User knows exactly what's happening

**Cons:**
- ⚠️ More complex
- ⚠️ Still may timeout on very long campaigns

---

## Solution 4: Status Command (Quick Check) 🔍

Add a `status` subcommand to check on running swarms:

```bash
bun orchestrate-v4.ts status <swarm-id>
```

**Output:**
```
Swarm: ffb-sourcing-20260312
Status: Running
Progress: 12/20 tasks (60%)
Duration: 18m 34s
Last update: 30 seconds ago
Current tasks:
  - task_7: Running on gemini (5m 12s)
  - task_8: Running on claude (3m 45s)
  - task_9: Waiting for dependencies

Results: /root/.swarm/results/ffb-sourcing-20260312.json (partial)
```

**Implementation:**
```typescript
// Read progress file + running tasks from logs
if (args[0] === "status") {
  const swarmId = args[1];
  const progressFile = join(swarmDir, "logs", `${swarmId}_progress.json`);
  const logFile = join(swarmDir, "logs", `${swarmId}.ndjson`);
  
  // Parse and display
  // ...
}
```

**Pros:**
- ✅ Simple to implement
- ✅ User can manually check anytime
- ✅ Works across chat sessions

**Cons:**
- ⚠️ Manual polling required
- ⚠️ Doesn't solve the "lost output" problem

---

## Recommended Approach

**For now (immediate fix):**
Use Solution 1 — always run long swarms with `--notify`:

```bash
nohup bun orchestrate-v4.ts campaign.json --notify sms > /tmp/swarm.log 2>&1 &
```

**For better UX (next iteration):**
Implement Solution 3 + Solution 4:
1. Add `status` command for manual checking
2. Wrap long swarms in a hybrid runner that:
   - Streams updates for first 12-14 minutes
   - Hands off to background + notification after that
   - Always saves results to file

**For best UX (future enhancement):**
Build a Zo Space dashboard:
- Real-time swarm status via polling API route
- Live progress bars
- WebSocket updates
- Historical swarm runs browser
- One-click re-run failed tasks

---

## Immediate Action Items

1. **Update swarm-running convention in SKILL.md** to always use `--notify` for campaigns >10 tasks
2. **Add `status` subcommand** to orchestrator (15 min implementation)
3. **Create wrapper script** `run-long-swarm.sh` that:
   - Detects campaign size
   - Auto-adds `--notify email` for >10 tasks
   - Starts in background with `nohup`
   - Prints status check command

Would you like me to implement any of these solutions?
