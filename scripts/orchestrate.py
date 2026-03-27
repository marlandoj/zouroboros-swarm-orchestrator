#!/usr/bin/env python3
"""Swarm Orchestrator v5.0.0 - Full-Featured Python Implementation"""
import json, os, sys, time, subprocess, threading, sqlite3, re
from pathlib import Path

WORKSPACE = os.environ.get("SWARM_WORKSPACE", "/home/workspace")
HOME = os.environ.get("HOME", "/root")
SWARM_DIR = Path(HOME, ".swarm")
LOGS_DIR = SWARM_DIR / "logs"; RESULTS_DIR = SWARM_DIR / "results"
HISTORY_DB = SWARM_DIR / "executor-history.db"
MEMORY_DB = Path("/home/workspace/.zo/memory/shared-facts.db")
REGISTRY = Path(WORKSPACE, "Skills", "zo-swarm-executors", "registry", "executor-registry.json")
LOCK_DIR = Path("/dev/shm")

LOGS_DIR.mkdir(parents=True, exist_ok=True); RESULTS_DIR.mkdir(parents=True, exist_ok=True)

# Routing constants
COMPLEXITY_AFFINITY = {
    "codex":       {"trivial":1.0,"simple":0.9,"moderate":0.5,"complex":0.2},
    "gemini":      {"trivial":0.7,"simple":0.8,"moderate":0.9,"complex":0.8},
    "hermes":      {"trivial":0.5,"simple":0.7,"moderate":0.8,"complex":0.7},
    "claude-code": {"trivial":0.6,"simple":0.7,"moderate":0.9,"complex":1.0},
}

ROUTING_WEIGHTS = {
    "balanced":  {"capability":0.30,"health":0.35,"complexityFit":0.20,"history":0.15},
    "fast":      {"capability":0.15,"health":0.25,"complexityFit":0.45,"history":0.15},
    "reliable":  {"capability":0.20,"health":0.45,"complexityFit":0.15,"history":0.20},
    "explore":   {"capability":0.40,"health":0.20,"complexityFit":0.20,"history":0.20},
}

DEFAULTS = {
    "localConcurrency": 8,
    "timeoutSeconds": 600,
    "maxRetries": 3,
    "enableMemory": True,
    "defaultMemoryStrategy": "hierarchical",
    "cascadeMode": True,  # cascade-off skips downstream when root fails
    "maxContextTokens": 16000,
    "crossTaskContextWindow": 3,
    "routingStrategy": "balanced",
}

def nlog(path, event, **kw):
    entry = json.dumps({"ts": str(__import__("datetime").datetime.now(__import__("datetime").UTC).isoformat().replace("+00:00","Z")), "event": event, **kw})
    with open(path, "a") as fh: fh.write(entry + "\n")

def init_history():
    try:
        db = sqlite3.connect(HISTORY_DB)
        db.execute("CREATE TABLE IF NOT EXISTS executor_history (id INTEGER PRIMARY KEY, executor TEXT, category TEXT, attempts INTEGER, successes INTEGER, avg_ms REAL, last_updated INTEGER, UNIQUE(executor, category))")
        db.close()
    except: pass

def load_executors():
    executors = {}
    if not REGISTRY.exists():
        print("WARN: Executor registry not found: " + str(REGISTRY))
        return executors
    try:
        raw = json.loads(REGISTRY.read_text())
        for ex in raw.get("executors", []):
            if ex.get("executor") in ("local", "") or not ex.get("executor"):
                executors[ex["id"]] = ex
    except Exception as e:
        print("WARN: Failed to load executors: " + str(e))
    print("OK: Loaded " + str(len(executors)) + " local executors")
    return executors

def get_bridge(exid, executors):
    ex = executors.get(exid)
    if not ex: return None
    p = Path(WORKSPACE) / ex.get("bridge", "")
    if p.exists(): return p
    alt = Path(WORKSPACE, exid + "-bridge.sh")
    if alt.exists(): return alt
    return None

def estimate_complexity(task):
    text = (task.get("task", "") + " " + (task.get("memoryMetadata", {}).get("category", "") or "")).lower()
    words = len(text.split())
    has_multi = bool(re.search(r"\b(then|after|next|step|finally)\b", text))
    has_tool = bool(re.search(r"\b(git|npm|bun|pip|curl|sed|grep)\b", text))
    has_ana = bool(re.search(r"\b(analyz|review|audit|compare)\b", text))
    score = (1 if words > 200 else 0) + (1 if has_multi else 0) + (1 if has_tool else 0) + (1 if has_ana else 0)
    return ["trivial", "simple", "moderate", "complex"][min(score, 3)]

def cap_score(task, ex):
    text = (task.get("task", "") + " " + (task.get("memoryMetadata", {}).get("category", "") or "")).lower()
    kw = [e.lower() for e in ex.get("expertise", [])] + [b.lower() for b in ex.get("best_for", [])]
    return min(1.0, sum(1 for k in kw if k in text) / max(1, len(kw)))

def health(cb):
    if not cb: return 1.0
    if cb.get("state") == "OPEN": return 0.0
    return max(0.0, 1.0 - cb.get("failures", 0) * 0.3)

def hist_score(exid, cat):
    try:
        conn = sqlite3.connect(HISTORY_DB, timeout=5)
        row = conn.execute("SELECT attempts, successes FROM executor_history WHERE executor=? AND category=?", [exid, cat or "general"]).fetchone()
        conn.close()
        return row[1] / row[0] if row and row[0] >= 3 else 0.5
    except: return 0.5

def rec_hist(exid, cat, ok, ms):
    try:
        conn = sqlite3.connect(HISTORY_DB)
        conn.execute("INSERT INTO executor_history (executor,category,attempts,successes,avg_ms,last_updated) VALUES (?,?,1,?,?,?) ON CONFLICT(executor,category) DO UPDATE SET attempts=attempts+1, successes=successes+?, avg_ms=(avg_ms*(attempts-1)+?)/attempts, last_updated=?",
            [exid, cat or "general", int(ok), ms, int(time.time()), int(ok), ms, int(time.time())])
        conn.commit(); conn.close()
    except: pass

def route(task, executors, cbs, strategy):
    cplx = estimate_complexity(task)
    cat = (task.get("memoryMetadata") or {}).get("category", "general")
    w = ROUTING_WEIGHTS.get(strategy, ROUTING_WEIGHTS["balanced"])
    cand = []
    for eid, ex in executors.items():
        cap = cap_score(task, ex)
        hl = health(cbs.get(eid))
        cf = COMPLEXITY_AFFINITY.get(eid, {}).get(cplx, 0.5)
        hi = hist_score(eid, cat)
        sc = w["capability"]*cap + w["health"]*hl + w["complexityFit"]*cf + w["history"]*hi
        cand.append((eid, ex.get("name", eid), sc))
    cand.sort(key=lambda x: -x[2])
    top = cand[0] if cand else ("claude-code", "Claude Code", 0)
    top3 = cand[:3]
    print("  [route:" + cplx + "] " + " vs ".join(e + "(" + str(round(s, 2)) + ")" for e, n, s in top3))
    return top

def topo(tasks):
    deps = {t["id"]: set(t.get("dependsOn", [])) for t in tasks}
    indeg = {t["id"]: len(deps[t["id"]]) for t in tasks}
    q = [tid for tid, d in indeg.items() if d == 0]
    result = []
    while q:
        tid = q.pop(0); result.append(tid)
        for t in tasks:
            if tid in deps.get(t["id"], []):
                indeg[t["id"]] -= 1
                if indeg[t["id"]] == 0: q.append(t["id"])
    remaining = [t["id"] for t in tasks if t["id"] not in result]
    return result + remaining

# P3: DAG Cascade Mitigation
# cascadeMode=True (default): task runs if all deps succeeded or failed
# cascadeMode=False: task runs ONLY if ALL deps succeeded (rescue failed-root subtrees)
def deps_ok(task, ok, fail, cascade_mode=True, failed_roots=None, skipped=None):
    deps = task.get("dependsOn", [])
    if not deps:
        return True  # Root tasks always run
    if cascade_mode:
        return all(ok.get(d) or fail.get(d) for d in deps)
    # cascade_mode=False: rescue subtree if root dep failed
    # Walk transitive closure — skip if ANY ancestor is a failed root
    fr = failed_roots or {}
    visited = set()
    def has_failed_root_ancestor(dep_id):
        if dep_id in visited:
            return False
        visited.add(dep_id)
        if fr.get(dep_id):
            return True  # This dep is a failed root
        # Recurse: check ancestors of this dep
        dep_task = next((t for t in _all_tasks if t["id"] == dep_id), None)
        if not dep_task:
            return False
        for ancestor in dep_task.get("dependsOn", []):
            if has_failed_root_ancestor(ancestor):
                return True
        return False
    for d in deps:
        if fail.get(d):
            if has_failed_root_ancestor(d):
                return False  # This task has a failed-root ancestor -> skip
    return all(ok.get(d) or fail.get(d) for d in deps)

# Global for transitive check (set by Orch.load_tasks)
_all_tasks = []  # P3: for transitive cascade analysis

def is_root_task(task):
    """A root task is one with no dependencies."""
    return len(task.get("dependsOn", [])) == 0


def get_memory_context(task, limit_tokens=2000):
    """Query zo-memory-system for relevant context, inject as summary."""
    if not MEMORY_DB.exists():
        return ""
    try:
        conn = sqlite3.connect(str(MEMORY_DB), timeout=5)
        # Search facts table for relevant entities
        query = (task.get("task", "") + " " +
                 task.get("memoryMetadata", {}).get("category", "") + " " +
                 " ".join(task.get("memoryMetadata", {}).get("tags", []))).lower()
        keywords = [w for w in query.split() if len(w) > 3][:10]
        if not keywords:
            return ""
        # Simple relevance: facts with entity or key matching keywords
        placeholders = ",".join("?" * len(keywords))
        rows = conn.execute(
            "SELECT entity, key, value FROM facts WHERE value != '' AND "
            "(expires_at IS NULL OR expires_at > ?) AND "
            "(entity IN (" + placeholders + ") OR key IN (" + placeholders + ")) "
            "ORDER BY created_at DESC LIMIT 5",
            [int(time.time())] + keywords + keywords
        ).fetchall()
        conn.close()
        if not rows:
            return ""
        lines = ["## Relevant Memory:"]
        for entity, key, value in rows:
            lines.append("- [[" + entity + "]]." + key + ": " + value[:100])
        ctx = "\n".join(lines)
        # Rough token estimate: ~4 chars/token
        if len(ctx) > limit_tokens * 4:
            ctx = ctx[:limit_tokens * 4]
        return "\n" + ctx
    except Exception as e:
        return ""

def build_prompt(task, completed, ctx_window):
    p = task.get("task", "")
    cat = (task.get("memoryMetadata", {}).get("category", "") or "")
    if cat: p = p + "\n\n[Category: " + cat + "]"
    p = p + get_memory_context(task)
    if completed:
        win = completed[-ctx_window:]
        lines = []
        for o in win:
            lines.append("### " + o["persona"] + " (" + o["category"] + "):\n" + o["summary"])
        p = p + "\n\n## Prior Findings:\n" + "\n".join(lines)
    if task.get("expectedMutations"):
        lines = []
        for m in task["expectedMutations"]:
            lines.append("  - " + m["file"] + " must contain: " + m["contains"])
        p = p + "\n\nREQUIRED CHANGES:\n" + "\n".join(lines)
    return p

def call_agent(exid, prompt, timeout_s, bridge_path):
    rf = "/tmp/swarm-result-" + str(os.getpid()) + "-" + str(int(time.time()*1000)) + ".txt"
    # Bridges have different arg signatures:
    # claude-code: only prompt (generates workdir internally)
    # codex/hermes/gemini: prompt + workdir
    args = [str(bridge_path)]
    if exid in ("claude-code",):
        args.append(prompt)
    else:
        args.extend([prompt, WORKSPACE])
    try:
        env = {**os.environ, "WORKSPACE": WORKSPACE}
        proc = subprocess.Popen(
            args,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, cwd=WORKSPACE, env=env)
        try:
            stdout, stderr = proc.communicate(timeout=timeout_s)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.communicate()
            return "", "Timeout after " + str(timeout_s) + "s"
        if proc.returncode == 0:
            try:
                out = Path(rf).read_text().strip()
                Path(rf).unlink(missing_ok=True)
                return out, None
            except:
                return stdout.strip() or "OK", None
        return "", (stderr.strip() or "exit " + str(proc.returncode))[:500]
    except Exception as e:
        return "", str(e)[:200]

def write_episode(swid, sok, sfail, ems, total, exids):
    try:
        if not MEMORY_DB.exists(): return
        conn = sqlite3.connect(str(MEMORY_DB), timeout=5)
        conn.execute("CREATE TABLE IF NOT EXISTS episodes (id INTEGER PRIMARY KEY, summary TEXT, outcome TEXT, happened_at INTEGER, entities TEXT, metadata TEXT)")
        outcome = "success" if sfail == 0 else "partial" if sfail < sok else "failure"
        conn.execute("INSERT INTO episodes (summary,outcome,happened_at,entities,metadata) VALUES (?,?,?,?,?)",
            ["Swarm " + swid + ": " + str(sok) + " succeeded, " + str(sfail) + " failed in " + str(round(ems/1000)) + "s", outcome, int(time.time()),
             json.dumps(["executor." + e for e in exids]),
             json.dumps({"swarm_id": swid, "tasks": total, "succeeded": sok, "failed": sfail, "elapsed_ms": ems})])
        conn.commit(); conn.close()
    except: pass

def status_cmd(swid):
    pf = LOGS_DIR / (swid + "_progress.json")
    rf = RESULTS_DIR / (swid + ".json")
    lp = LOCK_DIR / (swid + ".lock")
    if pf.exists():
        d = json.loads(pf.read_text())
        print("Swarm: " + swid)
        print("Status: " + d.get("status", "?"))
        if d.get("status") == "running" and lp.exists(): print("PID: " + lp.read_text().strip())
        e = int(d.get("elapsedMs", 0) / 1000)
        print("Progress: " + str(d.get("completed", 0)) + "/" + str(d.get("totalTasks", 0)) + " (" + str(d.get("percentComplete", 0)) + "%)")
        print("Failed: " + str(d.get("failed", 0)))
        print("Elapsed: " + str(e//60) + "m " + str(e%60) + "s")
        print("Results: " + str(rf) + " (" + str(rf.stat().st_size//1024) + "KB)")
    elif rf.exists():
        d = json.loads(rf.read_text())
        print("Swarm: " + swid); print("Status: " + d.get("status", "complete"))
        print("Succeeded: " + str(d.get("completed", 0)) + "/" + str(d.get("total", 0)))
        print("Failed: " + str(d.get("failed", 0)))
        e = int(d.get("elapsedMs", 0) / 1000)
        print("Duration: " + str(e//60) + "m " + str(e%60) + "s")
    else:
        print("No swarm found: " + swid); sys.exit(1)

def doctor_cmd():
    print("Swarm Doctor v5.0")
    for k, v in DEFAULTS.items(): print("  " + k + ": " + str(v))
    exs = load_executors()
    for eid, ex in exs.items():
        bp = get_bridge(eid, exs)
        if bp: print("  OK: " + eid + " bridge at " + str(bp))
        else: print("  MISSING: " + eid + " bridge")
    init_history(); print("  OK: history DB")
    print("OK: doctor passed")

class Orch:

    def __init__(self, swarm_id, cfg):
        self.swarm_id = swarm_id
        self.cfg = {**DEFAULTS, **cfg}
        self.tasks = []
        self.ok = {}
        self.fail = {}
        self.running = {}
        self.lock = threading.Lock()
        self.start_time = time.time()
        self.log_path = LOGS_DIR / (swarm_id + ".ndjson")
        self.prog_path = LOGS_DIR / (swarm_id + "_progress.json")
        self.res_path = RESULTS_DIR / (swarm_id + ".json")
        self.lock_path = LOCK_DIR / (swarm_id + ".lock")
        self.completed_outputs = []
        self.circuit_breakers = {}
        self.failed_root_tasks = {}  # P3: root tasks that failed (no deps on failed tasks)
        self.skipped_due_to_cascade = {}  # P3: tasks skipped because their root dep failed
        nlog(str(self.log_path), "swarm_start", swarm_id=swarm_id)
        init_history()
        self.executors = load_executors()
        for eid in self.executors:
            self.circuit_breakers[eid] = {"state": "CLOSED", "failures": 0}

    def init(self):
        self.lock_path.write_text(str(os.getpid()))
        print("Swarm " + self.swarm_id + " v5.0.0 (concurrency=" + str(self.cfg["localConcurrency"]) + ")")

    def write_progress(self, status):
        d = {
            "ts": str(__import__("datetime").datetime.now(__import__("datetime").UTC).isoformat().replace("+00:00","Z")),
            "swarmId": self.swarm_id,
            "totalTasks": len(self.tasks),
            "completed": len(self.ok),
            "failed": len(self.fail),
            "percentComplete": round(len(self.ok) / max(1, len(self.tasks)) * 100),
            "elapsedMs": int((time.time() - self.start_time) * 1000),
            "status": status,
        }
        self.prog_path.write_text(json.dumps(d))

    def load_tasks(self, path):
        self.tasks = json.loads(Path(path).read_text())
        global _all_tasks; _all_tasks = self.tasks  # P3: for transitive cascade check
        self.init()
        print("Tasks: " + str(len(self.tasks)))

    def run(self):
        tids = topo(self.tasks)
        task_map = {t["id"]: t for t in self.tasks}
        pending = set(tids)
        running = set()
        self.write_progress("running")
        print("Starting " + str(len(self.tasks)) + " tasks with concurrency " + str(self.cfg["localConcurrency"]))
        while pending or running:
            with self.lock:
                while len(running) < self.cfg["localConcurrency"] and pending:
                    for tid in list(pending):
                        # P3: cascade mode check
                        cascade_ok = deps_ok(task_map[tid], self.ok, self.fail,
                                           self.cfg.get("cascadeMode", True),
                                           self.failed_root_tasks,
                                           self.skipped_due_to_cascade)
                        if cascade_ok:
                            pending.remove(tid)
                            running.add(tid)
                            # P3: cascade-off = mark downstream of failed roots as skipped
                            if not self.cfg.get("cascadeMode", True):
                                for d in task_map[tid].get("dependsOn", []):
                                    if self.fail.get(d) and self.failed_root_tasks.get(d):
                                        self.skipped_due_to_cascade[tid] = d
                                        break
                            print(f"  >> dispatching [{tid}] -> running={len(running)}")
                            t = threading.Thread(target=self.exec_task, args=(task_map[tid], running,))
                            t.start()
            time.sleep(0.5)
        while len(self.ok) + len(self.fail) < len(self.tasks): time.sleep(0.5)
        self.save_results()
        self.shutdown()

    def exec_task(self, task, running_set):
        tid = task["id"]
        retries = 0
        tried = set()
        cat = (task.get("memoryMetadata") or {}).get("category", "general")
        dur = 0
        err = None
        while retries <= self.cfg["maxRetries"]:
            if task.get("persona") and task["persona"] != "auto" and retries == 0:
                exid = task["persona"]
            else:
                winner = route(task, self.executors, self.circuit_breakers, self.cfg["routingStrategy"])
                exid = winner[0]
                if exid in tried and len(tried) < len(self.executors):
                    alt = next((e for e in self.executors if e not in tried), None)
                    if alt:
                        exid = alt
                        print("  REROUTE [" + tid + "] " + exid)
            tried.add(exid)
            bp = get_bridge(exid, self.executors)
            if not bp:
                print("  MISSING [" + tid + "] bridge for " + exid)
                err = "No bridge for " + exid
                break
            tout = task.get("timeoutSeconds", self.cfg["timeoutSeconds"])
            prompt = build_prompt(task, self.completed_outputs, self.cfg["crossTaskContextWindow"])
            print("  RUN [" + tid + "] " + exid + " (attempt " + str(retries+1) + ")")
            t0 = time.time()
            out, err = call_agent(exid, prompt, tout, bp)
            dur = int((time.time() - t0) * 1000)
            rec_hist(exid, cat, not err, dur)
            if not err:
                with self.lock:
                    self.ok[tid] = {"taskId": tid, "success": True, "output": out, "durationMs": dur, "retries": retries}
                    self.completed_outputs.append({"persona": exid, "category": cat, "summary": out[:300]})
                    cb = self.circuit_breakers.get(exid)
                    if cb: cb["failures"] = 0
                print("  OK [" + tid + "] " + exid + " (" + str(dur/1000) + "s)")
                self.write_progress("running")
                with self.lock: running_set.discard(tid)
                return
            else:
                cb = self.circuit_breakers.get(exid)
                if cb: cb["failures"] = cb.get("failures", 0) + 1
                retries += 1
                print("  FAIL [" + tid + "] " + exid + ": " + str(err)[:80])
                if retries <= self.cfg["maxRetries"]:
                    wait = 2 ** (retries-1) * 0.5
                    print("  RETRY [" + tid + "] in " + str(round(wait, 1)) + "s...")
                    time.sleep(wait)
        with self.lock:
            # P3: mark root failures so downstream tasks can skip
            if is_root_task(task):
                self.failed_root_tasks[tid] = True
            self.fail[tid] = {"taskId": tid, "success": False, "error": str(err)[:500], "durationMs": dur, "retries": retries-1}
            running_set.discard(tid)
        self.write_progress("running")

    def save_results(self):
        ems = int((time.time() - self.start_time) * 1000)
        sok = len(self.ok); sfail = len(self.fail)
        # P3: count skipped tasks (downstream of failed roots, not run)
        sskipped = len(self.skipped_due_to_cascade)
        skipped_detail = {k: v for k, v in self.skipped_due_to_cascade.items()}
        cascade_rescued = sskipped  # tasks that would have failed under cascade-on
        results = {
            "swarmId": self.swarm_id,
            "status": "complete",
            "cascadeMode": self.cfg.get("cascadeMode", True),
            "cascadeRescued": cascade_rescued,  # P3: tasks skipped (rescued from cascade)
            "skippedDetail": skipped_detail,
            "completed": sok,
            "failed": sfail,
            "total": len(self.tasks),
            "elapsedMs": ems,
            "results": list(self.ok.values()) + list(self.fail.values())
        }
        self.res_path.write_text(json.dumps(results, indent=2))

    def shutdown(self):
        ems = int((time.time() - self.start_time) * 1000)
        sok = len(self.ok); sfail = len(self.fail)
        nlog(str(self.log_path), "swarm_complete", succeeded=sok, failed=sfail, elapsed_ms=ems)
        write_episode(self.swarm_id, sok, sfail, ems, len(self.tasks), list(self.executors.keys()))
        sk = len(self.skipped_due_to_cascade)
        cascade_msg = ""
        if not self.cfg.get("cascadeMode", True) and sk > 0:
            cascade_msg = " (" + str(sk) + " skipped due to root failure)"
        elif sk > 0:
            cascade_msg = " (cascade rescue: " + str(sk) + " skipped)"
        print("Swarm " + self.swarm_id + ": " + str(sok) + "/" + str(len(self.tasks)) + " OK in " + str(round(ems/1000)) + "s" + cascade_msg)
        self.write_progress("complete")
        try: self.lock_path.unlink()
        except: pass

def send_notification(swid, results):
    notify = os.environ.get("NOTIFY", "")
    if not notify: return
    if notify == "sms":
        msg = "Swarm " + swid + ": " + str(results["completed"]) + "/" + str(results["total"]) + " OK - " + results.get("status", "")
        print("SMS notification: " + msg)
    elif notify == "email":
        print("Email notification: " + str(len(json.dumps(results))) + " bytes")

def main():
    args = sys.argv[1:]
    if len(args) < 1:
        print("Usage: python3 orchestrate.py <tasks.json> [options]")
        print("  --swarm-id ID     : Set swarm ID")
        print("  --concurrency N   : Max parallel tasks (default: 8)")
        print("  --timeout S       : Per-task timeout in seconds (default: 600)")
        print("  --strategy STRAT  : balanced|fast|reliable|explore (default: balanced)")
        print("  --no-cascade       : Skip downstream tasks when root fails (default: cascade-on)")
        print("  --notify sms|email: Send notification on completion")
        print("  status <ID>       : Check swarm status")
        print("  doctor             : Run health checks")
        sys.exit(1)
    if args[0] == "status":
        if len(args) < 2: print("Usage: orchestrate.py status <swarm-id>"); sys.exit(1)
        status_cmd(args[1]); sys.exit(0)
    if args[0] == "doctor":
        doctor_cmd(); sys.exit(0)
    campaign = args[0]
    swarm_id = "swarm_" + str(int(time.time()))
    cfg = dict(localConcurrency=8, timeoutSeconds=600, maxRetries=3, routingStrategy="balanced", cascadeMode=True)
    i = 1
    while i < len(args):
        a = args[i]
        if a == "--swarm-id" and i+1 < len(args): swarm_id = args[i+1]; i += 2
        elif a == "--concurrency" and i+1 < len(args): cfg["localConcurrency"] = int(args[i+1]); i += 2
        elif a == "--timeout" and i+1 < len(args): cfg["timeoutSeconds"] = int(args[i+1]); i += 2
        elif a == "--max-retries" and i+1 < len(args): cfg["maxRetries"] = int(args[i+1]); i += 2
        elif a == "--strategy" and i+1 < len(args): cfg["routingStrategy"] = args[i+1]; i += 2
        elif a == "--no-cascade": cfg["cascadeMode"] = False; i += 1  # P3
        elif a == "--notify" and i+1 < len(args): os.environ["NOTIFY"] = args[i+1]; i += 2
        else: i += 1
    if not Path(campaign).exists():
        print("File not found: " + campaign); sys.exit(1)
    orch = Orch(swarm_id, cfg)
    orch.load_tasks(campaign)
    print("Swarm v5.0.0 | Strategy: " + cfg["routingStrategy"] + " | Retries: " + str(cfg["maxRetries"]))
    print("Results: " + str(orch.res_path))
    print()
    orch.run()
    results = json.loads(orch.res_path.read_text())
    send_notification(swarm_id, results)
    print("Done: " + str(orch.res_path))

if __name__ == "__main__": main()
