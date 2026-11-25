extends RefCounted
## Interpreter for Game Studio rule programs (IR version 1).
##
## Mirrors packages/rules-core/src/interpret.ts statement for statement. Both runtimes
## are checked against the same fixtures (tests/fixtures.json). GDScript has no
## exceptions, so errors and Stop are carried in member flags and every step checks them.
##
## Hosts are plain objects with two methods:
##   call_action(fn: String, args: Dictionary) -> Variant   (null, a Dictionary of results,
##                                                          or {"__error": "message"})
##   query(fn: String, args: Dictionary) -> Variant         (a value or {"__error": "message"})

const IR_VERSION := 1
const MAX_STATEMENTS := 20000
const MAX_REPEAT := 1000

const OP_ARITY := {
	"add": 2, "sub": 2, "mul": 2, "div": 2, "idiv": 2, "mod": 2, "min": 2, "max": 2,
	"neg": 1, "abs": 1, "floor": 1, "ceil": 1, "round": 1,
	"eq": 2, "neq": 2, "lt": 2, "lte": 2, "gt": 2, "gte": 2,
	"and": 2, "or": 2, "not": 1, "text": 1, "concat": 2,
}

var program: Dictionary = {}
var variables: Dictionary = {}

var _payload: Dictionary = {}
var _host: Object = null
var _temps: Dictionary = {}
var _trace: Array = []
var _logs: Array = []
var _statements: int = 0
var _max_statements: int = MAX_STATEMENTS
var _halted: bool = false
var _error: String = ""
var _error_node: String = ""
var _current: String = ""
var _event: String = ""


## Returns "" on success or an error message.
func load_program(p: Dictionary) -> String:
	if int(p.get("irVersion", 0)) != IR_VERSION:
		return "Unsupported rule program version: %s" % str(p.get("irVersion", "missing"))
	if typeof(p.get("handlers")) != TYPE_DICTIONARY or typeof(p.get("variables")) != TYPE_DICTIONARY:
		return "Rule program is missing handlers or variables"
	program = p
	reset()
	return ""


func reset() -> void:
	variables = {}
	var decls: Dictionary = program.get("variables", {})
	for name in decls:
		var decl: Dictionary = decls[name]
		variables[name] = _norm(decl.get("initial"))


func has_handler(event: String) -> bool:
	var handlers: Dictionary = program.get("handlers", {})
	return handlers.has(event)


func run(event: String, payload: Dictionary, host: Object, max_statements: int = MAX_STATEMENTS) -> Dictionary:
	var result := {"handled": false, "halted": false, "trace": [], "logs": [], "statements": 0, "error": null, "errorNode": null}
	var handlers: Dictionary = program.get("handlers", {})
	if not handlers.has(event):
		return result
	result["handled"] = true
	_payload = {}
	for key in payload:
		_payload[key] = _norm(payload[key])
	_host = host
	_temps = {}
	_trace = []
	_logs = []
	_statements = 0
	_max_statements = max_statements
	_halted = false
	_error = ""
	_error_node = ""
	_current = ""
	_event = event
	var handler: Dictionary = handlers[event]
	_exec_block(handler.get("body", []))
	result["halted"] = _halted and _error == ""
	result["trace"] = _trace
	result["logs"] = _logs
	result["statements"] = _statements
	if _error != "":
		result["error"] = _error
		result["errorNode"] = _error_node if _error_node != "" else null
	return result


func _fail(message: String) -> void:
	if _error == "":
		_error = message
		_error_node = _current


func _stopped() -> bool:
	return _halted or _error != ""


func _exec_block(stmts: Array) -> void:
	for stmt in stmts:
		if _stopped():
			return
		_statements += 1
		if _statements > _max_statements:
			_fail("Stopped after %d steps (possible runaway rule)" % _max_statements)
			return
		if stmt.has("node") and stmt["node"] != null:
			_current = str(stmt["node"])
		var kind: String = str(stmt.get("s", ""))
		match kind:
			"trace":
				var node_id: String = str(stmt.get("node", ""))
				_current = node_id
				if _trace.is_empty() or _trace[_trace.size() - 1] != node_id:
					_trace.append(node_id)
			"set":
				_exec_set(stmt)
			"call":
				_exec_call(stmt)
			"if":
				var cond = _eval(stmt.get("cond", {}))
				if _error != "":
					return
				if typeof(cond) != TYPE_BOOL:
					_fail("Branch condition must be true or false")
					return
				_exec_block(stmt.get("then", []) if cond else stmt.get("else", []))
			"switch":
				var value = _eval(stmt.get("value", {}))
				if _error != "":
					return
				var key: String = _to_text(value)
				var cases: Dictionary = stmt.get("cases", {})
				_exec_block(cases[key] if cases.has(key) else stmt.get("default", []))
			"repeat":
				var n = _eval(stmt.get("count", {}))
				if _error != "":
					return
				if typeof(n) != TYPE_FLOAT or is_nan(n) or is_inf(n):
					_fail("Repeat count must be a number")
					return
				var times: int = int(clampf(floor(n), 0.0, float(MAX_REPEAT)))
				var index_name: String = str(stmt.get("index", ""))
				for i in range(times):
					_temps[index_name] = {"index": float(i)}
					_exec_block(stmt.get("body", []))
					if _stopped():
						return
				_temps.erase(index_name)
			"halt":
				_halted = true
				return
			_:
				_fail("Unknown statement '%s'" % kind)
				return


func _exec_set(stmt: Dictionary) -> void:
	var name: String = str(stmt.get("var", ""))
	var decls: Dictionary = program.get("variables", {})
	if not decls.has(name):
		_fail("Unknown variable '%s'" % name)
		return
	var value = _eval(stmt.get("value", {}))
	if _error != "":
		return
	var decl: Dictionary = decls[name]
	var var_type: String = str(decl.get("type", ""))
	if var_type == "text":
		value = _to_text(value)
	var ok: bool = (var_type == "number" and typeof(value) == TYPE_FLOAT) \
		or (var_type == "boolean" and typeof(value) == TYPE_BOOL) \
		or (var_type == "text" and typeof(value) == TYPE_STRING)
	if not ok:
		_fail("Variable '%s' needs %s" % [name, var_type])
		return
	variables[name] = value


func _exec_call(stmt: Dictionary) -> void:
	var args := {}
	var src: Dictionary = stmt.get("args", {})
	for key in src:
		args[key] = _eval(src[key])
		if _error != "":
			return
	var fn: String = str(stmt.get("fn", ""))
	var out_name: String = str(stmt.get("out", "")) if stmt.has("out") else ""
	if fn == "core.log":
		_logs.append(_to_text(args.get("message", "")))
		if out_name != "":
			_temps[out_name] = {}
		return
	if _host == null:
		_fail("No host is connected")
		return
	var res = _host.call_action(fn, args)
	if typeof(res) == TYPE_DICTIONARY and res.has("__error"):
		_fail(str(res["__error"]))
		return
	if out_name != "":
		var record := {}
		if typeof(res) == TYPE_DICTIONARY:
			for key in res:
				record[key] = _norm(res[key])
		_temps[out_name] = record


func _eval(expr: Dictionary) -> Variant:
	if _error != "":
		return null
	var kind: String = str(expr.get("e", ""))
	match kind:
		"const":
			return _norm(expr.get("v"))
		"var":
			var name: String = str(expr.get("name", ""))
			if not variables.has(name):
				_fail("Unknown variable '%s'" % name)
				return null
			return variables[name]
		"param":
			var pname: String = str(expr.get("name", ""))
			if not _payload.has(pname) or _payload[pname] == null:
				_fail("Event '%s' is missing '%s'" % [_event, pname])
				return null
			return _payload[pname]
		"temp":
			var record = _temps.get(str(expr.get("name", "")))
			var field: String = str(expr.get("field", ""))
			if typeof(record) != TYPE_DICTIONARY or not record.has(field):
				_fail("Value '%s' is not available yet" % field)
				return null
			return record[field]
		"op":
			var op: String = str(expr.get("op", ""))
			var raw_args: Array = expr.get("args", [])
			if not OP_ARITY.has(op) or raw_args.size() != int(OP_ARITY[op]):
				_fail("Operator '%s' has the wrong number of inputs" % op)
				return null
			var values: Array = []
			for a in raw_args:
				values.append(_eval(a))
				if _error != "":
					return null
			return _apply_op(op, values)
		"query":
			var qargs := {}
			var src: Dictionary = expr.get("args", {})
			for key in src:
				qargs[key] = _eval(src[key])
				if _error != "":
					return null
			var fn: String = str(expr.get("fn", ""))
			if _host == null:
				_fail("No host is connected")
				return null
			var answer = _host.query(fn, qargs)
			if typeof(answer) == TYPE_DICTIONARY and answer.has("__error"):
				_fail(str(answer["__error"]))
				return null
			if answer == null:
				_fail("Query '%s' returned no value" % fn)
				return null
			return _norm(answer)
	_fail("Unknown expression '%s'" % kind)
	return null


func _num(v: Variant, op: String) -> float:
	if typeof(v) != TYPE_FLOAT or is_nan(v):
		_fail("Operator '%s' expects a number, received %s" % [op, type_string(typeof(v))])
		return 0.0
	return v


func _bool(v: Variant, op: String) -> bool:
	if typeof(v) != TYPE_BOOL:
		_fail("Operator '%s' expects true/false, received %s" % [op, type_string(typeof(v))])
		return false
	return v


func _same(a: Variant, b: Variant) -> bool:
	if typeof(a) != typeof(b):
		return false
	return a == b


func _apply_op(op: String, args: Array) -> Variant:
	var a = args[0]
	var b = args[1] if args.size() > 1 else null
	match op:
		"add":
			return _num(a, op) + _num(b, op)
		"sub":
			return _num(a, op) - _num(b, op)
		"mul":
			return _num(a, op) * _num(b, op)
		"div":
			var d := _num(b, op)
			var n := _num(a, op)
			if _error != "":
				return null
			if d == 0.0:
				_fail("Division by zero")
				return null
			return n / d
		"idiv":
			var d2 := _num(b, op)
			var n2 := _num(a, op)
			if _error != "":
				return null
			if d2 == 0.0:
				_fail("Division by zero")
				return null
			return floor(n2 / d2)
		"mod":
			var d3 := _num(b, op)
			var n3 := _num(a, op)
			if _error != "":
				return null
			if d3 == 0.0:
				_fail("Modulo by zero")
				return null
			return fmod(fmod(n3, d3) + d3, d3)
		"min":
			return minf(_num(a, op), _num(b, op))
		"max":
			return maxf(_num(a, op), _num(b, op))
		"neg":
			return -_num(a, op)
		"abs":
			return absf(_num(a, op))
		"floor":
			return floor(_num(a, op))
		"ceil":
			return ceil(_num(a, op))
		"round":
			return floor(_num(a, op) + 0.5)
		"eq":
			return _same(a, b)
		"neq":
			return not _same(a, b)
		"lt":
			return _num(a, op) < _num(b, op)
		"lte":
			return _num(a, op) <= _num(b, op)
		"gt":
			return _num(a, op) > _num(b, op)
		"gte":
			return _num(a, op) >= _num(b, op)
		"and":
			var x := _bool(a, op)
			var y := _bool(b, op)
			return x and y
		"or":
			var p := _bool(a, op)
			var q := _bool(b, op)
			return p or q
		"not":
			return not _bool(a, op)
		"text":
			return _to_text(a)
		"concat":
			return _to_text(a) + _to_text(b)
	_fail("Unknown operator '%s'" % op)
	return null


## Integers become floats so values compare and print the same as in TypeScript.
static func _norm(v: Variant) -> Variant:
	if typeof(v) == TYPE_INT:
		return float(v)
	return v


static func _to_text(v: Variant) -> String:
	match typeof(v):
		TYPE_FLOAT:
			return format_number(v)
		TYPE_INT:
			return format_number(float(v))
		TYPE_BOOL:
			return "true" if v else "false"
		TYPE_STRING:
			return v
		TYPE_STRING_NAME:
			return str(v)
	return ""


## Mirrors formatNumber() in packages/rules-core/src/format.ts.
static func format_number(x: float) -> String:
	if is_nan(x):
		return "nan"
	if is_inf(x):
		return "inf" if x > 0.0 else "-inf"
	if x == floor(x) and absf(x) < 1e15:
		return str(int(x))
	var cents: int = int(floor(x * 100.0 + 0.5))
	var negative: bool = cents < 0
	var magnitude: int = absi(cents)
	var whole: int = floori(magnitude / 100.0)
	var frac: int = magnitude - whole * 100
	var text: String = str(whole)
	if frac != 0:
		var digits: String = "%02d" % frac
		if digits.ends_with("0"):
			digits = digits.substr(0, 1)
		text += "." + digits
	return ("-" if negative and magnitude != 0 else "") + text
