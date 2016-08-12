#winrmjs

Basically just the same as WinRB/winRM and pywinrm, but in Javascript. It allows you to invoke commands on Windows hosts from any machine with nodejs.

Unfortunately it only works with Basic authentication over HTTP at the moment, but this will eventually change so it works with Kerberos and (optionally) HTTPS.

Exported functions are promisified instead of original callback for easy use.

###Enable WinRM on remote hosts

Again, this is very insecure. This will change. Run these on the remote host.

```
winrm set winrm/config/client/auth '@{Basic="true"}'
winrm set winrm/config/service/auth '@{Basic="true"}'
winrm set winrm/config/service '@{AllowUnencrypted="true"}'
```

###Usage

To run normal cmd, use `run_command`.
For powershell, use `run_powershell`.

```
var winrm = require('winrm');
var run_params = winrm.get_run_params(host,port,path,username,password);
var commands = ['ipconfig', 'powershell -Command "Test-Connection 192.168.58.3"']; // commands to run

winrm.open_shell(run_params)
.then(function(shell_id){
    run_params.shell_id = shell_id;
    run_params.command = commands.join('; ');
    return winrm.run_powershell(run_params);
})
.then(function(command_id){
    run_params.command_id = command_id;
    return winrm.get_command_output(run_params);
})
.then(function(res){
    return winrm.close_command(run_params);
})
.then(function(res){
    return winrm.close_shell(run_params);
})
.catch(function(err){
    console.log(err);
})
.fin(function(){
    console.log('Yay! Everything is done');
});

```

It is also possible to execute a locally stored Powershell script on the host machine.
```
var run_params = winrm.get_run_params(host, port, path, username, password);
var commands = ['FindUser UserName'];

winrm.open_shell(run_params)
    .then(function (shell_id) {
        run_params.shell_id = shell_id;
        run_params.command = commands.join('; ');
        return winrm.run_powershell_script(run_params, './scripts/find_user.ps1');
    })
    .then(function (command_id) {
        run_params.command_id = command_id;
        return winrm.get_command_output(run_params);
    })
    .then(function (res) {
        console.log("Output   : " + res.output);
        console.log("ExitCode : " + res.exitCode);
        console.log("State    : " + res.state);
        return winrm.close_command(run_params);
    })
    .then(function (res) {
        return winrm.close_shell(run_params);
    })
    .catch(function (err) {
        console.log(err);
    })
    .fin(function () {
        console.log('Yay! Everything is done');
    });
```

This will read the script file contents and execute it in Powershell before executing the specified command. 

### Credit
The original Winrmjs was developed by Jacob Ludriks - https://github.com/jacobludriks/winrmjs
This fork builds on work done by Barak Shirali - https://github.com/barak-shirali/winrmjs

