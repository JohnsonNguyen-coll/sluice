import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root=fileURLToPath(new URL('../',import.meta.url));
const localForge=join(homedir(),'.foundry','bin',process.platform==='win32'?'forge.exe':'forge');
const binary=process.env.FORGE_BIN || (existsSync(localForge)?localForge:'forge');
const result=spawnSync(binary,process.argv.slice(2),{cwd:root,stdio:'inherit',env:process.env});
if(result.error){console.error('Foundry could not start. Install forge or set FORGE_BIN.');process.exit(1);}
process.exit(result.status ?? 1);
