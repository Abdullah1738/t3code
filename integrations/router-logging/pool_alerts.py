"""Pool alerts use a guard-owned child and the existing Telegram sender."""
import re


def valid(episode):
    return (isinstance(episode, dict)
            and isinstance(episode.get('provider'), str)
            and re.fullmatch(r'[a-z0-9_-]{1,64}', episode['provider'])
            and isinstance(episode.get('id'), str)
            and re.fullmatch(r'[a-f0-9-]{36}', episode['id'])
            and type(episode.get('since')) is int and episode['since'] > 0
            and type(episode.get('open')) is bool
            and (episode['open'] or type(episode.get('endedAt')) is int and episode['endedAt'] >= episode['since']))


class PoolAlerts:
    def __init__(self, state, notify, save):
        self.state, self.notify, self.save = state, notify, save

    def step(self, now, episodes):
        cutoff = now - 30 * 86400000
        for episode in episodes:
            if not valid(episode):
                continue
            identity = episode['id']
            # API history has no age limit. Do not recreate delivery state after
            # cleanup, but keep draining any previously persisted pending entry.
            if not episode['open'] and episode['endedAt'] < cutoff and identity not in self.state:
                continue
            entry = self.state.setdefault(identity, {})
            entry['episode'] = episode
        # Retained deliveries outlive the API's bounded episode history and
        # continue on ticks where fetching a fresh snapshot fails.
        for identity, entry in list(self.state.items()):
            episode = entry.get('episode')
            if not valid(episode):
                continue
            # A recovery received before the first tick still gets its one alert
            # when the completed episode lasted at least two minutes.
            elapsed = (now if episode['open'] else episode['endedAt']) - episode['since']
            key = f'9router-pool:{episode["provider"]}:{identity}'
            if elapsed >= 120000 and not entry.get('alerted'):
                if 'pendingAlert' not in entry:
                    entry['pendingAlert'] = dict(text=f'9router {episode["provider"]} pool exhausted for {round(elapsed / 1000)} s', key=key)
                    self.save()
                pending = entry['pendingAlert']
                if self.notify(pending['text'], pending['key']):
                    entry['alerted'] = True
                    self.save()
            if not episode['open'] and entry.get('alerted') and not entry.get('recovered'):
                failed = episode.get('failedRequests', 0)
                failed = failed if type(failed) is int and failed >= 0 else 0
                if 'pendingRecovery' not in entry:
                    entry['pendingRecovery'] = dict(text=f'9router {episode["provider"]} pool recovered after {round(elapsed / 1000)} s; {failed} failed requests', key=key + ':recovered')
                    self.save()
                pending = entry['pendingRecovery']
                if self.notify(pending['text'], pending['key']):
                    entry['recovered'] = True
                    self.save()
        for identity, entry in list(self.state.items()):
            episode = entry.get('episode', {})
            delivered = entry.get('recovered') or episode.get('endedAt', now) - episode.get('since', now) < 120000
            if delivered and not episode.get('open', True) and episode.get('endedAt', now) < cutoff:
                del self.state[identity]
        self.save()


def serve():
    import fcntl
    import os
    import signal
    import threading
    import time
    from guard import Runtime, read_json, write_json
    from poller import Router
    from toollog import directory, emit
    runtime = Runtime()
    path = runtime.state_file.with_name('pool-alerts.json')
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with path.with_suffix('.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        os.chmod(lock.name, 0o600)
        state = read_json(path)
        def save():
            write_json(path, state)
            write_json(directory() / '.pool-episodes.json', {key: value['episode'] for key, value in state.items() if 'episode' in value})
        alerts = PoolAlerts(state, runtime.notify, save)
        stopped = threading.Event()
        signal.signal(signal.SIGTERM, lambda *_: stopped.set())
        signal.signal(signal.SIGINT, lambda *_: stopped.set())
        router = None
        while not stopped.is_set():
            episodes = []
            try:
                router = router or Router(component='pool-alerts', event_name='pool.endpoint.get')
                episodes = router.get('/api/monitoring/pools')['episodes']
            except Exception:
                emit('guard', 'guard.error', kind='error', error=dict(tag='pool_snapshot_failed'))
            alerts.step(time.time() * 1000, episodes)
            stopped.wait(15)
