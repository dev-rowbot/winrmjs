var http = require('http');
var uuid = require('node-uuid');
var js2xmlparser = require("js2xmlparser");
var parsestring = require('xml2js').parseString;

function getsoapheader(param,callback) {
	if (!param['message_id']) param['message_id'] = uuid.v4();
	if (!param['resource_uri']) param['resource_uri'] = null;
	var header = {
		"@": {
			"xmlns:env": "http://www.w3.org/2003/05/soap-envelope",
			"xmlns:a": "http://schemas.xmlsoap.org/ws/2004/08/addressing",
			"xmlns:p": "http://schemas.microsoft.com/wbem/wsman/1/wsman.xsd",
			"xmlns:rsp": "http://schemas.microsoft.com/wbem/wsman/1/windows/shell",
			"xmlns:w": "http://schemas.dmtf.org/wbem/wsman/1/wsman.xsd"
		},
		"env:Header": {
			"a:To": "http://windows-host:5985/wsman",
			"a:ReplyTo": {
				"a:Address": {
					"@": {
						"mustUnderstand": "true"
					},
					"#": "http://schemas.xmlsoap.org/ws/2004/08/addressing/role/anonymous"
				}
			},
			"w:MaxEnvelopeSize": {
				"@": {
					"mustUnderstand": "true"
				},
				"#": "153600"
			},
			"a:MessageID": "uuid:" + param['message_id'],
			"w:Locale": {
				"@": {
					"mustUnderstand": "false",
					"xml:lang": "en-US"
				}
			},
			"p:DataLocale": {
				"@": {
					"mustUnderstand": "false",
					"xml:lang": "en-US"
				}
			},
			//timeout should be PT60S = 60 seconds in ISO format
			"w:OperationTimeout": "PT60S",
			"w:ResourceURI": {
				"@": {
					"mustUnderstand": "true"
				},
				"#": param['resource_uri']
			},
			"a:Action": {
				"@": {
					"mustUnderstand": "true"
				},
				"#": param['action']
			}
		}
	}
	if (param['shell_id']) {
		header['env:Header']['w:SelectorSet'] = [];
		header['env:Header']['w:SelectorSet'].push({
			"w:Selector": {
				"@": {
					"Name": "ShellId"
				},
				"#": param['shell_id']
			}
		});
	}
	callback(header);
}
function open_shell(params, callback) {
	getsoapheader({
		"resource_uri": "http://schemas.microsoft.com/wbem/wsman/1/windows/shell/cmd",
		"action": "http://schemas.xmlsoap.org/ws/2004/09/transfer/Create"
	},function(res) {
		res['env:Body'] = {
			"rsp:Shell": [
				{
					"rsp:InputStreams": "stdin",
					"rsp:OutputStreams": "stderr stdout"
				}
			]
		};
		res['env:Header']['w:OptionSet'] = [];
		res['env:Header']['w:OptionSet'].push({
			"w:Option": [
				{
					"@": {
						"Name": "WINRS_NOPROFILE"
					},
					"#": "FALSE"
				},
				{
					"@": {
						"Name": "WINRS_CODEPAGE"
					},
					"#": "437"
				}
			]
		})

		send_http(res,params.host,params.port,params.path,params.auth,function(err,result) {
			if (result['s:Envelope']['s:Body'][0]['s:Fault']) {
				callback(new Error(result['s:Envelope']['s:Body'][0]['s:Fault'][0]['s:Code'][0]['s:Subcode'][0]['s:Value'][0]));
			}
			else {
				var shellid = result['s:Envelope']['s:Body'][0]['rsp:Shell'][0]['rsp:ShellId'][0];
				callback(null,shellid);
			}
		});
	});
}

function run_command(params,callback) {
	getsoapheader({
		"resource_uri": "http://schemas.microsoft.com/wbem/wsman/1/windows/shell/cmd",
		"action": "http://schemas.microsoft.com/wbem/wsman/1/windows/shell/Command",
		"shell_id": params.shellid
	}, function(res) {
		res['env:Header']['w:OptionSet'] = [];
		res['env:Header']['w:OptionSet'].push({
			"w:Option":	[
				{
					"@": {
						"Name": "WINRS_CONSOLEMODE_STDIN"
					},
					"#": "TRUE"
				},
				{
					"@": {
						"Name": "WINRS_SKIP_CMD_SHELL"
					},
					"#": "FALSE"
				}
			]
		});
		res['env:Body'] = []
		res['env:Body'].push({
			"rsp:CommandLine": {
				"rsp:Command": params.command
			}
		})
		send_http(res,params.host,params.port,params.path,params.auth,function(err,result) {
			var commandid = result['s:Envelope']['s:Body'][0]['rsp:CommandResponse'][0]['rsp:CommandId'][0];
			callback(null,commandid);
		});
	});
};

function get_command_output(params,callback) {
	getsoapheader({
		"resource_uri": "http://schemas.microsoft.com/wbem/wsman/1/windows/shell/cmd",
		"action": "http://schemas.microsoft.com/wbem/wsman/1/windows/shell/Receive",
		"shell_id": params.shellid
	}, function(res) {
		res['env:Body'] = {
			"rsp:Receive": {
				"rsp:DesiredStream": {
					"@": {
						"CommandId": params.commandid
					},
					"#": "stdout stderr"
				}
			}
		}
		send_http(res,params.host,params.port,params.path,params.auth,function(err,result) {
			if (result) {
				//find a better way of getting this data. [2] is just a guess at the moment
				//also need to get stderr interface
				//also check rsp:CommandState for State "http://schemas.microsoft.com/wbem/wsman/1/windows/shell/CommandState/Done"
				//"http://schemas.microsoft.com/wbem/wsman/1/windows/shell/CommandState/Running" = do not want
				//also check rsp:ExitCode for 0 being done..
				var output = new Buffer(result['s:Envelope']['s:Body'][0]['rsp:ReceiveResponse'][0]['rsp:Stream'][2]['_'], 'base64').toString('ascii');
				callback(null,output);
			}
		});
	});
}

function cleanup_command(params,callback) {
	getsoapheader({
		"resource_uri": "http://schemas.microsoft.com/wbem/wsman/1/windows/shell/cmd",
		"action": "http://schemas.microsoft.com/wbem/wsman/1/windows/shell/Signal",
		"shell_id": params.shellid
	}, function(res) {
		res['env:Body'] = {
			"rsp:Signal": {
				"@": {
					"CommandId": params.commandid
				},
				"rsp:Code": "http://schemas.microsoft.com/wbem/wsman/1/windows/shell/signal/terminate"
			}
		}
		var uuid = res['env:Header']['a:MessageID'];

		send_http(res,params.host,params.port,params.path,params.auth,function(err,result) {
			var relatesto = result['s:Envelope']['s:Header'][0]['a:RelatesTo'][0];
			if (relatesto == uuid) {
				callback(null, "closed");
				return;
			}
			callback(new Error("UUID in response does not match UUID sent"));
		});
	});
}

function close_shell(params,callback) {
	getsoapheader({
		"resource_uri": "http://schemas.microsoft.com/wbem/wsman/1/windows/shell/cmd",
		"action": "http://schemas.xmlsoap.org/ws/2004/09/transfer/Delete",
		"shell_id": params.shellid
	}, function(res) {
		res['env:Body'] = { }
		var uuid = res['env:Header']['a:MessageID']
		//strip "uuid:" from var uuid
		send_http(res,params.host,params.port,params.path,params.auth,function(err,result) {
			var relatesto = result['s:Envelope']['s:Header'][0]['a:RelatesTo'][0];
			if (relatesto == uuid) {
				callback(null, "closed");
				return;
			}
			callback(new Error("UUID in response does not match UUID sent"));
		});
	});
}

function send_http(data,host,port,path,auth,callback) {
	var xmldata = js2xmlparser('env:Envelope',data);
	var options = {
		hostname: host,
		port: port,
		path: path,
		method: 'POST',
		headers: {
			'Content-Type': 'application/soap+xml;charset=UTF-8',
			'User-Agent': 'JS WinRM Client',
			'Content-Length': xmldata.length,
			'Authorization': auth
		},
	};
	var req = http.request(options, function(response) {
		if (!(response.statusCode == '200')) callback (new Error(response.statusCode));
		//console.log('STATUS: ' + response.statusCode);
		//console.log('HEADERS: ' + JSON.stringify(response.headers));
		response.setEncoding('utf8');
		response.on('data', function (chunk) {
			parsestring(chunk, function(err, chunkparsed) {
				if (err) callback(new Error(err));
				callback(null, chunkparsed);
			});
		});
	});
	req.on('error', function(e) {
		console.log('problem with request: ' + e.message);
	});
	req.write(xmldata);
	req.end();
}

function run(command,host,port,path,username,password,callback) {
	var runparams = {
		command: command,
		host: host,
		port: port,
		path: path,
		username: username,
		password: password,
		auth: null,
		shellid: null,
		commandid: null,
		results: null
	}
	//Basic authentication over http unfortunately. Definitely not secure at all.
	//Todo: implement kerberos
	//Todo: implement HTTPS
	var auth = 'Basic ' + new Buffer(runparams.username + ':' + runparams.password).toString('base64');
	runparams['auth'] = auth;

	open_shell(runparams, function(err, response) {
		if (err) { return false; }
		runparams.shellid = response;
		function receiveddata(response) {
			if (response == false) {
			  //command not finished, trying loop again
			  return false;
			}
			//command has finished running, getting results
			runparams['results'] = response;
			cleanup_command(runparams, function(err, response) {
				if (err) { return false; }
				close_shell(runparams, function(err,response) {
					callback(null,runparams['results']);
				});
			});
		}
		function pollCommand() {
			get_command_output(runparams,function(err,response) {
				//finished
				if (err) {
					receiveddata(FALSE);
					return
				}
				if (response) {
					receiveddata(response);
					return;
				}
				setTimeout(function() {
					pollCommand()
				}, 1000);
			});
		}
		run_command(runparams,function(err, response) {
			if (err) { return false; }
			runparams.commandid = response;
			pollCommand();
		});
	});
}

module.exports = run;
