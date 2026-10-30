const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.join(__dirname,'..');
const read=name=>fs.readFileSync(path.join(root,name),'utf8').replace(/\r\n/g,'\n');
const js=read('app.js'),css=read('style.css');
const scriptHash=crypto.createHash('sha256').update(js).digest('base64');
const html=read('index.html').replace('<link rel="stylesheet" href="./style.css" />','<style>'+css+'</style>').replace('<script src="./app.js"></script>','<script>'+js+'</script>').replace("script-src 'self'", "script-src 'sha256-"+scriptHash+"'");
fs.mkdirSync(path.join(root,'release'),{recursive:true});fs.writeFileSync(path.join(root,'release','Moongle-Preview.html'),html);
