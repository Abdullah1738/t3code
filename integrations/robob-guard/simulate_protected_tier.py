"""Linux scheduling surrogate; writes raw HTTP timings and cleans up owned PIDs."""
import argparse
import http.server
import json
import math
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import urllib.request


def summarize(rows):
    values = sorted(r['ms'] for r in rows if 'error' not in r)
    return dict(requests=len(rows), errors=sum('error' in r for r in rows),
                p50_ms=values[math.ceil(.50*len(values))-1] if values else None,
                p95_ms=values[math.ceil(.95*len(values))-1] if values else None)


def child(mode, portfile):
    if mode == 'server':
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                # A small amount of CPU makes scheduling delay observable.
                total = sum(i*i for i in range(10000))
                data = str(total).encode()
                self.send_response(200)
                self.send_header('Content-Length',str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *args):
                pass
        server = http.server.HTTPServer(('127.0.0.1',0), Handler)
        Path(portfile).write_text(str(server.server_port))
        server.serve_forever()
    os.nice(19)
    if mode == 'hog':
        while True:
            sum(i*i for i in range(10000))
    elif mode == 'fork':
        while True:
            pid = os.fork()
            if pid == 0:
                os._exit(0)
            os.waitpid(pid,0)


def main(output, seconds):
    output.mkdir(parents=True,exist_ok=True)
    nproc = int(subprocess.check_output(['nproc'],text=True,timeout=10).strip())
    portfile = output/'server.port'
    portfile.unlink(missing_ok=True)
    children = []
    result = dict(platform=sys.platform,nproc=nproc,hogs=4*nproc,seconds_per_phase=seconds,
                  surrogate='Linux nice 19 hogs + fork loop; server nice 0 then -5; no Darwin QoS or ProcessType',
                  at=time.time(),load_before=os.getloadavg())
    def spawn(mode):
        p = subprocess.Popen([sys.executable,'-I',__file__,'--child',mode,'--portfile',str(portfile)],
                             start_new_session=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        children.append(p)
        return p
    def measure(port):
        rows=[]
        deadline=time.monotonic()+seconds
        while time.monotonic()<deadline:
            start=time.perf_counter()
            try:
                with urllib.request.urlopen('http://127.0.0.1:%s/'%port,timeout=5) as response:
                    response.read()
                    status=response.status
                rows.append(dict(ms=(time.perf_counter()-start)*1000,status=status))
            except Exception as error:
                rows.append(dict(ms=(time.perf_counter()-start)*1000,error=type(error).__name__))
            time.sleep(.05)
        return dict(summary=summarize(rows),rows=rows,load=os.getloadavg())
    try:
        server=spawn('server')
        deadline=time.monotonic()+10
        while not portfile.exists():
            if time.monotonic()>deadline or server.poll() is not None:
                raise RuntimeError('server startup failed')
            time.sleep(.01)
        port=int(portfile.read_text())
        for _ in range(4*nproc):
            spawn('hog')
        spawn('fork')
        result['server_pid']=server.pid
        result['without']=measure(port)
        command=['sudo','-n','renice','-n','-5','-p',str(server.pid)]
        change=subprocess.run(command,capture_output=True,text=True,timeout=10)
        result['renice']=dict(command=command,exit=change.returncode,stdout=change.stdout,stderr=change.stderr,
                              actual_nice=os.getpriority(os.PRIO_PROCESS,server.pid))
        if change.returncode or result['renice']['actual_nice'] != -5:
            raise RuntimeError('negative nice unavailable on this box')
        result['with']=measure(port)
    except Exception as error:
        result['failure']=str(error)
        raise
    finally:
        for p in children:
            if p.poll() is None:
                os.killpg(p.pid, signal.SIGTERM)
        for p in children:
            try:
                p.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(p.pid, signal.SIGKILL)
                p.wait(timeout=10)
        result['owned_children_reaped']=all(p.poll() is not None for p in children)
        (output/'simulation.json').write_text(json.dumps(result,indent=2)+'\n')
        print(json.dumps({k:v for k,v in result.items() if k not in ('without','with')}))
        for key in ('without','with'):
            if key in result:
                print(key,json.dumps(result[key]['summary']))


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--output',type=Path)
    parser.add_argument('--seconds',type=int,default=60)
    parser.add_argument('--child',choices=['hog','fork','server'])
    parser.add_argument('--portfile')
    args=parser.parse_args()
    if args.child:
        child(args.child,args.portfile)
    else:
        main(args.output,args.seconds)
