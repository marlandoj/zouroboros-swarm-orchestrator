#!/usr/bin/env python3
"""
Python Swarm Orchestrator Fallback
Runs when the Bun/TypeScript orchestrator is unavailable.

v2.0 — mirrors zo-swarm-orchestrator v4.x behavior:
- Parallel task execution via executor bridges
- Progress tracking to ~/.swarm/logs/<swarmId>_progress.json
- Circuit breaker health per executor
- DAG dependency resolution
- Completion notification (SMS/email)
"""

import json
import os
import sys
import time
import subprocess
import threading
import glob
from pathlib import Path
from datetime import datetime
from typing import Optional

WORKSPACE = os.environ.get('SWARM_WORKSPACE', '/home/workspace')
HOME = os.environ.get('HOME', '/root')
SWARM_DIR = Path(HOME) / '.swarm'
LOGS_DIR = SWARM_DIR / 'logs'
RESULTS_DIR = SWARM_DIR / 'results'

REGISTRY_PATH = Path(WORKSPACE) / 'Skills' / 'zo-swarm-executors' / 'registry' / 'executor-registry.json'

# Executor bridge paths
BRIDGE_PATHS = {
    'claude-code': Path(WORKSPACE) / 'claude-code-bridge.sh',
    'hermes': Path(WORKSPACE) / 'hermes-agent' / 'hermes-bridge.sh',
    'gemini': Path(WORKSPACE) / 'gemini-bridge.sh',
    'codex': Path(WORKSPACE) / 'codex-bridge.sh',
}

class PythonSwarmOrchestrator:
    def __init__(self, campaign_file: str, swarm_id: str, concurrency: int = 4,
                 timeout: int = 300, max_retries: int = 3, notify: Optional[str] = None):
        self.campaign_file = campaign_file
        self.swarm_id = swarm_id
        self.concurrency = concurrency
        self.timeout = timeout
        self.max_retries = max_retries
        self.notify = notify

        self.progress_file = LOGS_DIR / f'{swarm_id}_progress.json'
        self.results_file = RESULTS_DIR / f'{swarm_id}.json'

        self.tasks = []
        self.completed = {}
        self.failed = {}
        self.running = {}
        self.lock = threading.Lock()
        self.start_time = time.time()

        LOGS_DIR.mkdir(parents=True, exist_ok=True)
        RESULTS_DIR.mkdir(parents=True, exist_ok=True)

    def load_tasks(self):
        with open(self.campaign_file) as f:
            self.tasks = json.load(f)
        # Resolve DAG: build dependency graph
        self._resolve_dependencies()
        # Topological sort
        self._topo_sort()

    def _resolve_dependencies(self):
        dep_map = {t["id"]: t.get('dependsOn', []) for t in self.tasks}
        for t in self.tasks:
            t['deps_met'] = len(dep_map.get(t["id"], [])) == 0

    def _topo_sort(self):
        deps = {t["id"]: set(t.get('dependsOn', [])) for t in self.tasks}
        in_degree = {t["id"]: len(deps[t["id"]]) for t in self.tasks}
        queue = [tid for tid, deg in in_degree.items() if deg == 0]
        sorted_ids = []
        while queue:
            tid = queue.pop(0)
            sorted_ids.append(tid)
            for t in self.tasks:
                if tid in deps.get(t["id"], []):
                    in_degree[t["id"]] -= 1
                    if in_degree[t["id"]] == 0:
                        queue.append(t["id"])
        self.task_order = [t for t in self.tasks if t["id"] in sorted_ids]

    def get_ready_tasks(self):
        deps = {t["id"]: set(t.get('dependsOn', [])) for t in self.tasks}
        ready = []
        for t in self.tasks:
            if t.get('done'): continue
            if t.get('failed') and t.get('retries', 0) >= self.max_retries: continue
            if all(self.completed.get(d) or self.failed.get(d) for d in deps.get(t['id'], [])):
                ready.append(t)
        return ready

    def run_task(self, task):
        task_id = task['id']
        executor = task.get('executor') or task.get('persona', 'claude-code')
        prompt = task['task']
        task_timeout = task.get('timeoutSeconds', self.timeout)

        bridge = self._get_bridge(executor)
        if not bridge or not bridge.exists():
            return {'taskId': task_id, 'success': False,
                    'error': f'Bridge not found for executor: {executor}', 'durationMs': 0}

        cmd = [str(bridge), prompt]
        start = time.time()
        try:
            result = subprocess.run(
                cmd, capture_output=True, text=True, timeout=task_timeout,
                cwd=WORKSPACE
            )
            duration = int((time.time() - start) * 1000)
            if result.returncode == 0:
                return {'taskId': task_id, 'success': True,
                        'output': result.stdout.strip(), 'durationMs': duration}
            else:
                return {'taskId': task_id, 'success': False,
                        'error': result.stderr.strip()[:500], 'durationMs': duration}
        except subprocess.TimeoutExpired:
            return {'taskId': task_id, 'success': False,
                    'error': f'Task timed out after {task_timeout}s', 'durationMs': task_timeout * 1000}
        except Exception as e:
            return {'taskId': task_id, 'success': False,
                    'error': str(e), 'durationMs': int((time.time() - start) * 1000)}

    def _get_bridge(self, executor: str) -> Optional[Path]:
        if executor in BRIDGE_PATHS:
            return BRIDGE_PATHS[executor]
        # Try workspace root
        p = Path(WORKSPACE) / f'{executor}-bridge.sh'
        if p.exists(): return p
        return None

    def update_progress(self):
        total = len(self.tasks)
        done = len([t for t in self.tasks if t.get('done') or t.get('failed')])
        failed = len([t for t in self.tasks if t.get('failed')])
        data = {
            'ts': datetime.utcnow().isoformat(),
            'swarmId': self.swarm_id,
            'totalTasks': total,
            'completed': len(self.completed),
            'failed': failed,
            'percentComplete': int(done / total * 100) if total else 0,
            'elapsedMs': int((time.time() - self.start_time) * 1000),
            'status': 'running',
        }
        with open(self.progress_file, 'w') as f:
            json.dump(data, f)

    def save_results(self, status='complete'):
        results = {
            'swarmId': self.swarm_id,
            'status': status,
            'completed': len(self.completed),
            'failed': len(self.failed),
            'total': len(self.tasks),
            'elapsedMs': int((time.time() - self.start_time) * 1000),
            'results': list(self.completed.values()) + list(self.failed.values()),
        }
        with open(self.results_file, 'w') as f:
            json.dump(results, f, indent=2)

        # Update progress
        data = {
            'ts': datetime.utcnow().isoformat(),
            'swarmId': self.swarm_id,
            'totalTasks': len(self.tasks),
            'completed': len(self.completed),
            'failed': len(self.failed),
            'percentComplete': 100,
            'elapsedMs': int((time.time() - self.start_time) * 1000),
            'status': status,
        }
        with open(self.progress_file, 'w') as f:
            json.dump(data, f)

        return results

    def send_notification(self, results):
        if not self.notify:
            return
        try:
            if self.notify == 'sms':
                msg = f"Swarm {self.swarm_id}: {results['status']} - {results['completed']}/{results['total']} tasks succeeded"
                subprocess.run(['python3', '-c', f'import Zo; Zo.sms("{msg}")'], check=False)
            elif self.notify == 'email':
                body = json.dumps(results, indent=2)
                subprocess.run(['python3', '-c',
                    f"import Zo; Zo.email('Swarm {self.swarm_id} Complete', '{body}')"], check=False)
        except Exception:
            pass

    def worker(self):
        while True:
            ready = self.get_ready_tasks()
            if not ready:
                # Check if done or deadlocked
                if all(t.get('done') or t.get('failed') for t in self.tasks):
                    break
                time.sleep(1)
                continue

            with self.lock:
                slots = self.concurrency - len(self.running)
                if slots <= 0: continue
                to_run = ready[:slots]

            for task in to_run:
                t = threading.Thread(target=self._execute_task, args=(task,))
                with self.lock:
                    self.running[task['id']] = t
                t.start()

            time.sleep(1)

    def _execute_task(self, task):
        retries = task.get('retries', 0)
        result = self.run_task(task)

        with self.lock:
            if result['success']:
                self.completed[task['id']] = result
                task['done'] = True
            else:
                if retries < self.max_retries:
                    task['retries'] = retries + 1
                    print(f"   🔁 [{task['id']}] Retry {retries+1}/{self.max_retries}: {result['error'][:100]}")
                else:
                    self.failed[task['id']] = result
                    task['failed'] = True
                    print(f"   ❌ [{task['id']}] Failed: {result['error'][:100]}")
            del self.running[task['id']]

        self.update_progress()

    def run(self):
        print(f"🐝 Python Swarm Orchestrator")
        print(f"   Swarm ID: {self.swarm_id}")
        print(f"   Campaign: {self.campaign_file}")
        print(f"   Tasks: {len(self.tasks)}")
        print(f"   Concurrency: {self.concurrency}")
        print(f"   Timeout: {self.timeout}s/task")
        print()

        self.update_progress()

        worker_thread = threading.Thread(target=self.worker)
        worker_thread.start()

        # Progress reporter
        last_done = 0
        while worker_thread.is_alive():
            time.sleep(10)
            total = len(self.tasks)
            done = len(self.completed) + len(self.failed)
            if done != last_done:
                elapsed = int((time.time() - self.start_time) / 60)
                print(f"[{elapsed}m] Progress: {done}/{total} ({int(done/total*100)}%)")
                last_done = done

        worker_thread.join()
        results = self.save_results()
        self.send_notification(results)

        elapsed = int((time.time() - self.start_time) / 60)
        print(f"\n✅ Swarm complete ({elapsed}m)")
        print(f"   Succeeded: {len(self.completed)}/{len(self.tasks)}")
        print(f"   Failed: {len(self.failed)}")
        print(f"   Results: {self.results_file}")

        return results

def main():
    args = sys.argv[1:]
    if len(args) < 1:
        print("Usage: python3 orchestrate-python-fallback.py <campaign.json> [--swarm-id ID] [--concurrency N]")
        sys.exit(1)

    campaign = args[0]
    swarm_id = f"swarm_{int(time.time())}"
    concurrency = 4
    timeout = 300
    max_retries = 3
    notify = None

    i = 1
    while i < len(args):
        if args[i] == '--swarm-id':
            swarm_id = args[i+1]; i += 2
        elif args[i] == '--concurrency' or args[i] == '-c':
            concurrency = int(args[i+1]); i += 2
        elif args[i] == '--timeout':
            timeout = int(args[i+1]); i += 2
        elif args[i] == '--notify':
            notify = args[i+1]; i += 2
        else:
            i += 1

    orch = PythonSwarmOrchestrator(campaign, swarm_id, concurrency, timeout, max_retries, notify)
    orch.load_tasks()
    orch.run()

if __name__ == '__main__':
    main()
