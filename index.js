var http = require('http');
var uuid = require('node-uuid');
var js2xmlparser = require("js2xmlparser");
var _ = require('lodash');
var parsestring = require('xml2js').parseString;
var q = require('q');
var fs = require('fs');

function getsoapheader(param, callback) {
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
	}, function (res) {
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

		send_http(res, params.host, params.port, params.path, params.auth, function (err, result) {
			if (err) {
				// 401 or 403 error here for authentication
				callback(err);
			} else if (!result) {
				callback(new Error('No Result'));
			} else if (result['s:Envelope']['s:Body'][0]['s:Fault']) {
				callback(new Error(result['s:Envelope']['s:Body'][0]['s:Fault'][0]['s:Code'][0]['s:Subcode'][0]['s:Value'][0]));
			} else {
				var shell_id = result['s:Envelope']['s:Body'][0]['rsp:Shell'][0]['rsp:ShellId'][0];
				callback(null, shell_id);
			}
		});
	});
}

function run_command(params, callback) {
	getsoapheader({
		"resource_uri": "http://schemas.microsoft.com/wbem/wsman/1/windows/shell/cmd",
		"action": "http://schemas.microsoft.com/wbem/wsman/1/windows/shell/Command",
		"shell_id": params.shell_id
	}, function (res) {
		res['env:Header']['w:OptionSet'] = [];
		res['env:Header']['w:OptionSet'].push({
			"w:Option": [
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
		send_http(res, params.host, params.port, params.path, params.auth, function (err, result) {
			var command_id = result['s:Envelope']['s:Body'][0]['rsp:CommandResponse'][0]['rsp:CommandId'][0];
			callback(null, command_id);
		});
	});
};

function get_command_output(params, callback) {
	getsoapheader({
		"resource_uri": "http://schemas.microsoft.com/wbem/wsman/1/windows/shell/cmd",
		"action": "http://schemas.microsoft.com/wbem/wsman/1/windows/shell/Receive",
		"shell_id": params.shell_id
	}, function (res) {
		res['env:Body'] = {
			"rsp:Receive": {
				"rsp:DesiredStream": {
					"@": {
						"CommandId": params.command_id
					},
					"#": "stdout stderr"
				}
			}
		}
		send_http(res, params.host, params.port, params.path, params.auth, function (err, result) {
			if (result) {
				var exitCode = result['s:Envelope']['s:Body'][0]['rsp:ReceiveResponse'][0]['rsp:CommandState'][0]['rsp:ExitCode'];
				if (exitCode) {
					exitCode = exitCode[0];
				} else {
					exitCode = 1;
				}
				stateValue = result['s:Envelope']['s:Body'][0]['rsp:ReceiveResponse'][0]['rsp:CommandState'][0]['$']['State'];
				state = stateValue.substring(stateValue.lastIndexOf('/') + 1);
				var output = _(result['s:Envelope']['s:Body'][0]['rsp:ReceiveResponse'][0]['rsp:Stream']).filter(function (s) {
					return s._;
				}).map(function (s) {
					return new Buffer(s._, 'base64').toString('ascii');
				}).join('');
				callback(null, {
					output: output,
					exitCode: exitCode,
					state: state
				});
			}
		});
	});
}

function cleanup_command(params, callback) {
	getsoapheader({
		"resource_uri": "http://schemas.microsoft.com/wbem/wsman/1/windows/shell/cmd",
		"action": "http://schemas.microsoft.com/wbem/wsman/1/windows/shell/Signal",
		"shell_id": params.shell_id
	}, function (res) {
		res['env:Body'] = {
			"rsp:Signal": {
				"@": {
					"CommandId": params.command_id
				},
				"rsp:Code": "http://schemas.microsoft.com/wbem/wsman/1/windows/shell/signal/terminate"
			}
		}
		var uuid = res['env:Header']['a:MessageID'];

		send_http(res, params.host, params.port, params.path, params.auth, function (err, result) {
			var relatesto = result['s:Envelope']['s:Header'][0]['a:RelatesTo'][0];
			if (relatesto == uuid) {
				callback(null, "Closed Command");
				return;
			}
			callback(new Error("UUID in response does not match UUID sent"));
		});
	});
}

function close_shell(params, callback) {
	getsoapheader({
		"resource_uri": "http://schemas.microsoft.com/wbem/wsman/1/windows/shell/cmd",
		"action": "http://schemas.xmlsoap.org/ws/2004/09/transfer/Delete",
		"shell_id": params.shell_id
	}, function (res) {
		res['env:Body'] = {}
		var uuid = res['env:Header']['a:MessageID']
		//strip "uuid:" from var uuid
		send_http(res, params.host, params.port, params.path, params.auth, function (err, result) {
			var relatesto = result['s:Envelope']['s:Header'][0]['a:RelatesTo'][0];
			if (relatesto == uuid) {
				callback(null, "Closed shell");
				return;
			}
			callback(new Error("UUID in response does not match UUID sent"));
		});
	});
}

function send_http(data, host, port, path, auth, callback) {
	var xmldata = js2xmlparser('env:Envelope', data);
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
	var req = http.request(options, function (response) {
		if (!(response.statusCode == '200')) return callback(new Error(response.statusCode));
		response.setEncoding('utf8');
		var resStr = '';
		response.on('data', function (chunk) {
			resStr += chunk;
		});
		response.on('end', function () {
			parsestring(resStr, function (err, chunkparsed) {
				if (err) {
					callback(new Error(err));
				}
				callback(null, chunkparsed);
			});
		});
	});
	req.on('error', function (e) {
		console.log('problem with request: ' + e.message);
	});
	req.write(xmldata);
	req.end();
}

function run(command, host, port, path, username, password, callback) {
	var runparams = get_run_params(host, port, path, username, password);
	runparams['command'] = command;
	open_shell(runparams, function (err, response) {
		if (err) {
			return callback(err, response);
		}
		runparams.shell_id = response;
		function receiveddata(response) {
			if (response == false) {
				//command not finished, trying loop again
				return false;
			}
			//command has finished running, getting results
			runparams['results'] = response;
			cleanup_command(runparams, function (err, response) {
				if (err) { return false; }
				close_shell(runparams, function (err, response) {
					callback(null, runparams['results']);
				});
			});
		}
		var totalResponse = {};
		totalResponse.output = '';
		function pollCommand() {
			get_command_output(runparams, function (err, response) {
				//finished
				if (err) {
					receiveddata(FALSE);
					return
				}
				if (response.state != 'Running') {
					if (totalResponse.output !== '') {
						response.output = totalResponse.output + response.output;
					}
					receiveddata(response);
					return;
				}
				if (response.state == 'Running') {
					totalResponse.output += response.output;
				}
				setTimeout(function () {
					pollCommand()
				}, 1000);
			});
		}
		run_command(runparams, function (err, response) {
			if (err) { return false; }
			runparams.command_id = response;
			pollCommand();
		});
	});
}

function get_command_output_promisified(runparams) {
	var deferred = q.defer();
	var retries = 10;

	var totalResponse = {};
	totalResponse.output = '';

	function poll_command() {
		get_command_output(runparams, function (err, response) {
			if (err) {
				return deferred.reject(err);
			} else if (response.state != 'Running') {
				response.output = totalResponse.output + response.output;
				return deferred.resolve(response);
			} else {
				if (response.state == 'Running') {
					totalResponse.output += response.output;
				}
				retries--;
				if (retries > 0) {
					setTimeout(function () {
						poll_command()
					}, 1000);
				} else {
					return deferred.reject(new Error('Timeout on command result'));
				}
			}
		});
	}
	poll_command();
	return deferred.promise;
}


function get_run_params(host, port, path, username, password) {
	var runparams = {
		host: host,
		port: port,
		path: path,
		username: username,
		password: password,
		auth: null,
		shell_id: null,
		command_id: null,
		results: null
	};

	var auth = 'Basic ' + new Buffer(runparams.username + ':' + runparams.password).toString('base64');
	runparams['auth'] = auth;
	return runparams;
}


function run_ps_script(runparams, script, callback) {
	var psScript = '';
	fs.readFile(script, 'utf8', function (err, data) {
		if (err) {
			return console.log(err);
		}

		psScript = data;

		psCommand = psScript + '\n' + runparams.command;
		console.log("=============================================");
		console.log ('Command: ' + runparams.command);
		console.log("=============================================");
		console.log ('Script : \n' + psScript);
		console.log("=============================================");
		console.log ('Combined: \n' + psCommand);
		console.log("=============================================");
		var base64cmd = new Buffer(psCommand, 'utf16le').toString('base64');
		runparams.command = 'powershell -encodedcommand ' + base64cmd;

		return run_command(runparams, callback);

	});

}

function run_ps(runparams, callback) {
	var base64cmd = new Buffer(runparams.command, 'utf16le').toString('base64');
	runparams.command = 'powershell -encodedcommand ' + base64cmd;
	return run_command(runparams, callback);
}

module.exports = {
	run: run,
	get_run_params: get_run_params, // used to get run params
	open_shell: q.denodeify(open_shell), // used to get shell id
	close_shell: q.denodeify(close_shell),
	close_command: q.denodeify(cleanup_command),
	run_command: q.denodeify(run_command), // used to get command id
	run_powershell: q.denodeify(run_ps), // run powershell
	run_powershell_script: q.denodeify(run_ps_script), // run powershell
	get_command_output: get_command_output_promisified // getting command result from stream
};
