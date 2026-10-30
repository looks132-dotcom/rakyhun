const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const root=path.join(__dirname,'..'),shim=path.join(root,'.tools','shims');
fs.mkdirSync(shim,{recursive:true});
// The bundled development runtime has Node but no globally installed npm.
const localNpm=path.join(root,'.tools','package','bin','npm-cli.js');
if(fs.existsSync(localNpm))fs.writeFileSync(path.join(shim,'npm.cmd'),'@echo off\r\n"'+process.execPath+'" "'+localNpm+'" %*\r\n');
const result=spawnSync(process.execPath,[path.join(root,'node_modules','electron-builder','cli.js'),'--win','nsis','--x64','--publish','never'],{cwd:root,stdio:'inherit',env:{...process.env,PATH:shim+path.delimiter+process.env.PATH}});
process.exitCode=result.status??1;
