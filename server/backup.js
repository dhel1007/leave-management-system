import {DatabaseSync,backup} from 'node:sqlite';
import {existsSync,mkdirSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
const source=resolve(process.env.DB_PATH || 'data/leave.sqlite');
if(!existsSync(source)) {console.error('Database not found. Start the app first.');process.exit(1);}
const destination=resolve('data/backups/leave-'+new Date().toISOString().replaceAll(':','-')+'.sqlite');
mkdirSync(dirname(destination),{recursive:true});
const db=new DatabaseSync(source,{readOnly:true});
try {await backup(db,destination);console.log('Backup saved: '+destination);} finally {db.close();}
