#!/usr/bin/env python3

import asyncio, ssl
from asterism_lib import main

if __name__ == '__main__':
    ssl._create_default_https_context = ssl._create_unverified_context
    asyncio.run(main(url='https://10.18.6.212:4443/6.009/2pm', extension='.py'))
