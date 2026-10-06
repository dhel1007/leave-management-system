import {defineConfig} from '@playwright/test';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
export default defineConfig({
  testDir:'./tests/ui',timeout:60000,fullyParallel:false,workers:1,
  reporter:'list',use:{baseURL:'http://127.0.0.1:3019',headless:true,timezoneId:'Asia/Manila',actionTimeout:10000,channel:'chrome',viewport:{width:1440,height:1000},trace:'retain-on-failure'},
  webServer:{command:'node server/index.js',url:'http://127.0.0.1:3019',reuseExistingServer:false,timeout:20000,
    env:{PORT:'3019',DB_PATH:join(tmpdir(),'agency-leave-ui-'+randomUUID()+'.sqlite'),ADMIN_PASSWORD:'Temporary!2026'}}
});
