#!/usr/bin/env python3

import asyncio, fileinput, os, re, signal, sys, urllib.parse, urllib.request, uuid, webbrowser

# regular expression for magic lines
TELESCOPE = re.compile(r'.{0,5} +Asterism +\*\*\* +(?P<file>\S+) +(?P<pull><?)-(?P<push>>?) +(?P<url>\S+) +\*\*\*\n')

def magic_files(url, candidates):
    '''
    Find files with valid magic lines.
    '''
    with fileinput.input(files=candidates) as files:
        for line in files:
            if (match := TELESCOPE.match(line)) and (magic := match.groupdict()):
                if (magic['file'] == os.path.basename(files.filename()) and magic['url'] == url):
                    yield {
                        'name': files.filename(),
                        'mode': 'push' if magic['push'] else 'pull' if magic['pull'] else None,
                    }
            if files.filelineno() >= 10:
                files.nextfile()

async def watch_and_send(url, token, filenames):
    '''
    Watch for new versions of *push* files on disk and send them to the server.
    '''
    sent = {}
    while True:
        for filename in [ f['name'] for f in magic_files(url, filenames) ]:
            with open(filename) as f:
                content = f.read()
            digest = hash(content)
            if (filename not in sent) or (sent[filename] != digest):
                print(f'* Sending {os.path.relpath(filename)}')
                with open(filename) as c:
                    data = urllib.parse.urlencode({
                        'content': c.read(),
                    }).encode()
                urllib.request.urlopen(f'{url}/push/{os.path.basename(filename)}/{token}', data)
                sent[filename] = digest
        await asyncio.sleep(10)

async def receive_and_save(url, token, filenames):
    '''
    Receive new versions of *pull* files from the server and save them to disk.
    '''
    pass

def stop(signalnum, frame):
    '''
    Handle signal by exiting.
    '''
    print('*** Goodbye!')
    exit()

async def main(url, extension):
    '''
    Find magic files, authenticate, then send and receive updates.
    '''
    signal.signal(signal.SIGINT, stop)
    print('*** Asterism *** press ctrl-c to stop')
    
    # required Python version
    py_min_version = (3, 8)
    if sys.version_info < py_min_version:
        exit(f'*** Python {".".join(map(str, py_min_version))} required')
    
    # find files in the same directory
    candidates = [
        os.path.join(sys.path[0], f) for f in os.listdir(sys.path[0]) if f.endswith(extension)
    ]
    
    # limit to files with magic lines
    files = list(magic_files(url, candidates))
    if files == []:
        exit('*** No magic files found')
    else:
        print(f'* Found {len(files)} magic file{"" if len(files) == 1 else "s"}')
    
    # authenticate
    identifier = uuid.uuid4()
    start = f'{url}/start/{identifier}'
    print(f'* Opening a browser window, {start}')
    webbrowser.open(start, new=1)
    print('*   please log in there...')
    try:
        with urllib.request.urlopen(f'{url}/await/{identifier}') as u:
            token = u.read().decode('utf-8')
    except urllib.error.HTTPError as e:
        exit(f'*** {e}')
    print(f'* Hello, {token.split(":")[0]}!')
    
    # the stars have aligned
    async def run():
        try:
            return await asyncio.gather(
                watch_and_send(url, token, [ f['name'] for f in files if f['mode'] == 'push']),
                # receive_and_save(url, token, [ f['name'] for f in files if f['mode'] == 'pull']),
            )
        except asyncio.CancelledError:
            raise # cancellation propagates without warning
    
    # run for a while
    timeout_hours = 1
    try:
        await asyncio.wait_for(run(), timeout=60*60*timeout_hours)
    except asyncio.TimeoutError:
        exit(f'*** Stopping after {timeout_hours} hour{"" if timeout_hours == 1 else "s"}, goodbye!')
