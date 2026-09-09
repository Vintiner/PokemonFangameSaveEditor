/* Marshal 4.8 reading and surgical editing, in the browser.
 *
 * A direct port of the Ruby implementation, and held to the same rule: values
 * are located down to their byte range and edits are spliced over that range,
 * so everything the app has never seen is copied through untouched. */
(function (global) {
  "use strict";

  var FIXNUM_MIN = -(Math.pow(2, 30));
  var FIXNUM_MAX = Math.pow(2, 30) - 1;
  var ROOT_ID = -1;

  function EditError(message) {
    this.name = "EditError";
    this.message = message;
  }
  EditError.prototype = Object.create(Error.prototype);

  function ParseError(message) {
    this.name = "ParseError";
    this.message = message;
  }
  ParseError.prototype = Object.create(Error.prototype);

  /* Symbols and raw string bytes are held as latin1 so every byte survives a
   * round trip; display decodes as UTF-8 separately. */
  function latin1(bytes) {
    var out = "";
    for (var i = 0; i < bytes.length; i += 1) out += String.fromCharCode(bytes[i]);
    return out;
  }

  function fromLatin1(text) {
    var out = new Uint8Array(text.length);
    for (var i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i) & 0xff;
    return out;
  }

  function utf8(text) {
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(text);
    return fromLatin1(unescape(encodeURIComponent(text)));
  }

  function readUtf8(bytes) {
    if (typeof TextDecoder !== "undefined") {
      return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    }
    try {
      return decodeURIComponent(escape(latin1(bytes)));
    } catch (e) {
      return latin1(bytes);
    }
  }

  function concat(parts) {
    var total = 0;
    var i;
    for (i = 0; i < parts.length; i += 1) total += parts[i].length;
    var out = new Uint8Array(total);
    var at = 0;
    for (i = 0; i < parts.length; i += 1) {
      out.set(parts[i], at);
      at += parts[i].length;
    }
    return out;
  }

  // ---------------------------------------------------------------- encoding

  function packLong(number) {
    if (number === 0) return new Uint8Array([0]);
    if (number > 0 && number < 123) return new Uint8Array([number + 5]);
    if (number < 0 && number > -124) return new Uint8Array([(number - 5) & 0xff]);

    var buffer = [];
    var value = number;
    for (var i = 1; i < 5; i += 1) {
      buffer.push(value & 0xff);
      value >>= 8;
      if (value === 0) return new Uint8Array([i].concat(buffer));
      if (value === -1) return new Uint8Array([(-i) & 0xff].concat(buffer));
    }
    throw new EditError("Number is too large for this save format.");
  }

  function encodeInteger(value) {
    if (!(value >= FIXNUM_MIN && value <= FIXNUM_MAX)) {
      throw new EditError("Enter a whole number between " + FIXNUM_MIN + " and " + FIXNUM_MAX + ".");
    }
    return concat([new Uint8Array([0x69]), packLong(value)]);
  }

  function encodeNil() {
    return new Uint8Array([0x30]);
  }

  function encodeBoolean(value) {
    return new Uint8Array([value ? 0x54 : 0x46]);
  }

  function encodeString(text) {
    var bytes = utf8(text);
    return concat([new Uint8Array([0x22]), packLong(bytes.length), bytes]);
  }

  function symbolName(value) {
    var name = String(value == null ? "" : value).trim().replace(/^:/, "");
    if (!name) throw new EditError("A name can't be empty.");
    if (/\s/.test(name)) throw new EditError("A name can't contain spaces.");
    if (/[^\x20-\x7e]/.test(name)) {
      throw new EditError("Names have to be plain ASCII, like POTION or SUPER_POTION.");
    }
    return name;
  }

  function encodeSymbol(name) {
    var bytes = fromLatin1(symbolName(name));
    return concat([new Uint8Array([0x3a]), packLong(bytes.length), bytes]);
  }

  function encodeSymbolLink(index) {
    return concat([new Uint8Array([0x3b]), packLong(index)]);
  }

  /* Floats carry no symbols and take one object slot either way, so the
   * shortest round-trip form is safe to write. */
  function encodeFloat(value) {
    var text = String(value);
    if (value === Infinity) text = "inf";
    else if (value === -Infinity) text = "-inf";
    else if (Number.isNaN(value)) text = "nan";
    var bytes = fromLatin1(text);
    return concat([new Uint8Array([0x66]), packLong(bytes.length), bytes]);
  }

  // ----------------------------------------------------------------- reading

  function Node(kind, start) {
    this.kind = kind;
    this.start = start;
    this.children = [];
  }
  Node.prototype.byteLength = function () {
    return this.finish - this.start;
  };

  function Scanner(data) {
    this.data = data;
    this.pos = 0;
    this.index = new Map();
    this.dumps = [];
    this.objects = [];
    this.symbols = [];
    this.symbolRefs = [];
    this.currentRefs = [];
    this.trailing = 0;
  }

  Scanner.prototype.parse = function () {
    while (this.pos < this.data.length &&
           this.data[this.pos] === 4 && this.data[this.pos + 1] === 8) {
      this.symbols = [];
      this.objects = [];
      this.currentRefs = [];
      this.symbolRefs.push(this.currentRefs);
      this.pos += 2;
      this.dumps.push(this.readValue("value"));
    }
    if (!this.dumps.length) {
      throw new ParseError("This isn't a Ruby Marshal stream (expected bytes 04 08).");
    }
    this.trailing = this.data.length - this.pos;
    return this;
  };

  Scanner.prototype.readBytes = function (count) {
    if (this.pos + count > this.data.length) {
      throw new ParseError("Ran out of data at byte " + this.pos + ".");
    }
    var out = this.data.subarray(this.pos, this.pos + count);
    this.pos += count;
    return out;
  };

  Scanner.prototype.readLong = function () {
    if (this.pos >= this.data.length) {
      throw new ParseError("Ran out of data at byte " + this.pos + ".");
    }
    var c = this.data[this.pos];
    this.pos += 1;
    if (c > 127) c -= 256;
    if (c === 0) return 0;
    var n, i;
    if (c > 0) {
      if (c > 4) return c - 5;
      n = 0;
      for (i = 0; i < c; i += 1) n |= this.data[this.pos + i] << (8 * i);
      this.pos += c;
      return n;
    }
    if (c < -4) return c + 5;
    n = -1;
    for (i = 0; i < -c; i += 1) {
      n &= ~(0xff << (8 * i));
      n |= this.data[this.pos + i] << (8 * i);
    }
    this.pos += -c;
    return n;
  };

  Scanner.prototype.register = function (node) {
    node.objIndex = this.objects.length;
    this.objects.push(node);
  };

  Scanner.prototype.readIvars = function (node) {
    var count = this.readLong();
    for (var i = 0; i < count; i += 1) {
      var name = this.readValue("ivar_name");
      node.children.push([String(name.value), this.readValue("value")]);
    }
  };

  Scanner.prototype.readClassName = function () {
    return String(this.readValue("class_name").value);
  };

  Scanner.prototype.readValue = function (role) {
    var start = this.pos;
    if (this.pos >= this.data.length) {
      throw new ParseError("Ran out of data at byte " + this.pos + ".");
    }
    var tag = this.data[this.pos];
    this.pos += 1;
    var node = new Node("unknown", start);
    var count, i, key, value, raw;

    switch (tag) {
      case 0x30: node.kind = "nil"; break;
      case 0x54: node.kind = "true"; node.value = true; break;
      case 0x46: node.kind = "false"; node.value = false; break;
      case 0x69: node.kind = "int"; node.value = this.readLong(); break;
      case 0x3a:
        node.kind = "symbol";
        node.role = role;
        node.value = latin1(this.readBytes(this.readLong()));
        this.symbols.push(node.value);
        this.currentRefs.push(node);
        break;
      case 0x3b:
        node.kind = "symlink";
        node.role = role;
        node.ref = this.readLong();
        node.value = this.symbols[node.ref];
        this.currentRefs.push(node);
        break;
      case 0x40: node.kind = "link"; node.ref = this.readLong(); break;
      case 0x49:
        node.kind = "ivar";
        node.children.push(["value", this.readValue("value")]);
        this.readIvars(node);
        break;
      case 0x22:
        node.kind = "string";
        raw = this.readBytes(this.readLong());
        node.raw = raw.slice();
        node.value = readUtf8(raw);
        this.register(node);
        break;
      case 0x5b:
        node.kind = "array";
        this.register(node);
        count = this.readLong();
        for (i = 0; i < count; i += 1) node.children.push([String(i), this.readValue("value")]);
        break;
      case 0x7b:
      case 0x7d:
        node.kind = "hash";
        this.register(node);
        node.keyNodes = [];
        count = this.readLong();
        for (i = 0; i < count; i += 1) {
          key = this.readValue("value");
          value = this.readValue("value");
          node.keyNodes.push(key);
          node.children.push([keyLabel(key), value]);
        }
        if (tag === 0x7d) node.children.push(["default", this.readValue("value")]);
        break;
      case 0x6f:
        node.kind = "object";
        node.className = this.readClassName();
        this.register(node);
        this.readIvars(node);
        break;
      case 0x75:
        node.kind = "userdef";
        node.className = this.readClassName();
        node.raw = this.readBytes(this.readLong()).slice();
        node.value = node.raw.length;
        this.register(node);
        break;
      case 0x55:
        node.kind = "usermarshal";
        node.className = this.readClassName();
        this.register(node);
        node.children.push(["data", this.readValue("value")]);
        break;
      case 0x66:
        node.kind = "float";
        raw = latin1(this.readBytes(this.readLong()));
        node.value = raw === "inf" ? Infinity : raw === "-inf" ? -Infinity :
                     raw === "nan" ? NaN : parseFloat(raw.split("\u0000")[0]);
        this.register(node);
        break;
      case 0x6c:
        node.kind = "bignum";
        var sign = latin1(this.readBytes(1));
        var words = this.readLong();
        var digits = this.readBytes(words * 2);
        var total = 0;
        for (i = digits.length - 1; i >= 0; i -= 1) total = total * 256 + digits[i];
        node.value = sign === "-" ? -total : total;
        this.register(node);
        break;
      case 0x63:
      case 0x6d:
      case 0x4d:
        node.kind = tag === 0x63 ? "class" : "module";
        node.value = latin1(this.readBytes(this.readLong()));
        this.register(node);
        break;
      case 0x65:
        node.kind = "extended";
        node.className = this.readClassName();
        node.children.push(["value", this.readValue("value")]);
        break;
      case 0x43:
        node.kind = "uclass";
        node.className = this.readClassName();
        node.children.push(["value", this.readValue("value")]);
        break;
      case 0x53:
        node.kind = "struct";
        node.className = this.readClassName();
        this.register(node);
        this.readIvars(node);
        break;
      case 0x2f:
        node.kind = "regexp";
        node.value = latin1(this.readBytes(this.readLong()));
        this.pos += 1;
        this.register(node);
        break;
      case 0x64:
        node.kind = "data";
        node.className = this.readClassName();
        this.register(node);
        node.children.push(["value", this.readValue("value")]);
        break;
      default:
        throw new ParseError("Unknown type byte 0x" + tag.toString(16) + " at offset " + start + ".");
    }

    node.finish = this.pos;
    this.index.set(start, node);
    return node;
  };

  function keyLabel(key) {
    switch (key.kind) {
      case "symbol": case "symlink": return ":" + key.value;
      case "string": return key.value;
      case "int": case "float": return String(key.value);
      case "nil": return "nil";
      case "true": case "false": return String(key.value);
      default: return "<" + key.kind + ">";
    }
  }

  // --------------------------------------------------------------- presenter

  var ENCODING_IVARS = ["E", "encoding"];

  function effective(node) {
    if (node.kind !== "ivar") return node;
    if (!node.children.length) return node;
    var inner = node.children[0][1];
    var extras = node.children.slice(1);
    var onlyEncoding = extras.every(function (pair) {
      return ENCODING_IVARS.indexOf(pair[0]) !== -1;
    });
    if (inner.kind === "string" && onlyEncoding) return inner;
    return node;
  }

  function editorFor(node) {
    switch (node.kind) {
      case "int": return { type: "integer" };
      case "nil": return { type: "integer", blankIsNil: true };
      case "float": return { type: "float" };
      case "true": case "false": return { type: "boolean" };
      case "string": return { type: "string" };
      case "symbol": case "symlink":
        return node.role === "value" ? { type: "symbol" } : null;
      default: return null;
    }
  }

  function editable(node) {
    return editorFor(effective(node)) !== null;
  }

  function typeLabel(node) {
    node = effective(node);
    switch (node.kind) {
      case "int": return "Number";
      case "float": return "Decimal";
      case "string": return "Text";
      case "symbol": case "symlink": return "Name";
      case "true": case "false": return "Yes/no";
      case "nil": return "Empty";
      case "array": return "List of " + node.children.length;
      case "hash": return "Table of " + node.children.length;
      case "object": return node.className;
      case "ivar": return (node.children[0] && node.children[0][1].className) || "Value";
      case "userdef": return node.className + " (raw)";
      case "usermarshal": return node.className;
      case "struct": return node.className + " (struct)";
      case "link": return "Same as earlier value";
      case "bignum": return "Large number";
      case "root": return "File";
      default: return node.kind;
    }
  }

  function inputValue(node) {
    node = effective(node);
    switch (node.kind) {
      case "string": return node.value;
      case "symbol": case "symlink": return String(node.value);
      case "nil": return "";
      case "true": return "true";
      case "false": return "false";
      default: return String(node.value);
    }
  }

  function summary(node, tree) {
    node = effective(node);
    switch (node.kind) {
      case "int": case "float": case "bignum": return String(node.value);
      case "string": return JSON.stringify(node.value);
      case "symbol": case "symlink": return ":" + node.value;
      case "true": return "true";
      case "false": return "false";
      case "nil": return "empty";
      case "array": return briefList(node, tree);
      case "hash": return node.children.length + (node.children.length === 1 ? " entry" : " entries");
      case "object": case "struct": case "usermarshal": return node.children.length + " fields";
      case "userdef": return node.raw.length + " bytes of " + node.className + " data";
      case "link":
        var target = tree && tree.scanner.objects[node.ref];
        return target ? "same as " + typeLabel(target).toLowerCase() + " at byte " + target.start
                      : "points to an earlier value";
      default: return "";
    }
  }

  function briefList(node, tree) {
    var parts = [];
    for (var i = 0; i < node.children.length; i += 1) {
      var piece = summary(node.children[i][1], tree);
      if (parts.join(", ").length + piece.length > 60) break;
      parts.push(piece);
    }
    return "[" + parts.join(", ") + (parts.length < node.children.length ? ", …" : "") + "]";
  }

  function labelFor(name, node) {
    var base = String(name).replace(/^@/, "").replace(/^:/, "").replace(/_/g, " ");
    return base || typeLabel(node);
  }

  // -------------------------------------------------------------- navigation

  function Tree(data) {
    this.data = data;
    this.scanner = new Scanner(data).parse();
    this.root = this.buildRoot();
    this.parents = new Map();
    this.labels = new Map();
    this.labels.set(this.root.start, "File");
    this.indexParents(this.root);
  }

  Tree.prototype.buildRoot = function () {
    if (this.scanner.dumps.length === 1) return this.scanner.dumps[0];
    var root = new Node("root", ROOT_ID);
    root.finish = this.data.length;
    for (var i = 0; i < this.scanner.dumps.length; i += 1) {
      root.children.push(["Section " + (i + 1), this.scanner.dumps[i]]);
    }
    return root;
  };

  Tree.prototype.indexParents = function (node) {
    var children = effective(node).children;
    for (var i = 0; i < children.length; i += 1) {
      var child = children[i][1];
      this.parents.set(child.start, node);
      this.labels.set(child.start, labelFor(children[i][0], child));
      this.indexParents(child);
    }
  };

  Tree.prototype.node = function (offset) {
    offset = Number(offset);
    if (offset === this.root.start) return this.root;
    return this.scanner.index.get(offset) || null;
  };

  Tree.prototype.label = function (node) {
    return this.labels.get(node.start) || typeLabel(node);
  };

  Tree.prototype.children = function (node) {
    return effective(node).children;
  };

  Tree.prototype.breadcrumbs = function (node) {
    var trail = [];
    var current = node;
    while (current) {
      trail.unshift(current);
      var parent = this.parents.get(current.start);
      if (!parent || parent.start === current.start) break;
      current = parent;
    }
    return trail;
  };

  Tree.prototype.pathParts = function (node) {
    var self = this;
    return this.breadcrumbs(node).slice(0, -1).map(function (ancestor) {
      return { label: self.label(ancestor), offset: ancestor.start };
    });
  };

  Tree.prototype.walk = function (node, visit) {
    var stack = [node];
    while (stack.length) {
      var current = stack.pop();
      if (visit(current) === false) return;
      for (var i = current.children.length - 1; i >= 0; i -= 1) stack.push(current.children[i][1]);
    }
  };

  Tree.prototype.nodeContaining = function (offset) {
    var best = null;
    this.walk(this.root, function (node) {
      if (node.start === ROOT_ID) return;
      if (offset < node.start || offset >= node.finish) return;
      if (!best || node.byteLength() <= best.byteLength()) best = node;
    });
    return best;
  };

  Tree.prototype.parseQuery = function (raw) {
    var text = String(raw || "").trim();
    if (!text) return { kind: "empty" };
    var m = text.match(/^(?:byte|offset|@)\s*[:#]?\s*(\d+)$/i);
    if (m) return { kind: "offset", offset: parseInt(m[1], 10) };
    m = text.match(/^0x([0-9a-f]+)$/i);
    if (m) return { kind: "offset", offset: parseInt(m[1], 16) };
    if (/^(?:[0-9a-f]{2}[\s,]+)+[0-9a-f]{2}$/i.test(text)) {
      var pairs = text.match(/[0-9a-f]{2}/gi).map(function (p) { return parseInt(p, 16); });
      return { kind: "bytes", pattern: new Uint8Array(pairs) };
    }
    return { kind: "text", text: text.toLowerCase() };
  };

  Tree.prototype.valueText = function (node) {
    var target = effective(node);
    switch (target.kind) {
      case "string": return target.value;
      case "symbol": case "symlink": return String(target.value);
      case "int": case "float": case "bignum": return String(target.value);
      case "object": case "userdef": case "usermarshal": case "struct":
        return String(target.className || "");
      default: return "";
    }
  };

  Tree.prototype.search = function (raw, scope, limit) {
    var query = this.parseQuery(raw);
    scope = scope || this.root;
    limit = limit || 200;
    var self = this;
    var results = [];

    function within(node) {
      if (scope === self.root) return true;
      return node.start >= scope.start && node.finish <= scope.finish;
    }

    if (query.kind === "empty") return results;

    if (query.kind === "offset") {
      var hit = this.nodeContaining(query.offset);
      return hit && within(hit) ? [hit] : [];
    }

    if (query.kind === "bytes") {
      var from = scope === this.root ? 0 : scope.start;
      var ceiling = scope === this.root ? this.data.length : scope.finish;
      while (from < ceiling) {
        var found = indexOfBytes(this.data, query.pattern, from);
        if (found < 0 || found >= ceiling) break;
        var node = this.nodeContaining(found);
        if (node && results.indexOf(node) === -1) results.push(node);
        if (results.length >= limit) break;
        from = found + 1;
      }
      return results;
    }

    this.walk(scope, function (node) {
      if (node === scope) return;
      var label = (self.labels.get(node.start) || "").toLowerCase();
      if (label.indexOf(query.text) !== -1 ||
          self.valueText(node).toLowerCase().indexOf(query.text) !== -1) {
        results.push(node);
      }
      if (results.length >= limit) return false;
    });
    return results;
  };

  Tree.prototype.stats = function () {
    var count = 0;
    this.walk(this.root, function () { count += 1; });
    return {
      bytes: this.data.length,
      dumps: this.scanner.dumps.length,
      values: count - (this.scanner.dumps.length > 1 ? 1 : 0),
      trailing: this.scanner.trailing
    };
  };

  function indexOfBytes(haystack, needle, from) {
    outer:
    for (var i = from; i <= haystack.length - needle.length; i += 1) {
      for (var j = 0; j < needle.length; j += 1) {
        if (haystack[i + j] !== needle[j]) continue outer;
      }
      return i;
    }
    return -1;
  }

  // ----------------------------------------------------------------- editing

  var SYMBOL_KINDS = ["symbol", "symlink"];

  function isSymbol(node) {
    return SYMBOL_KINDS.indexOf(node.kind) !== -1;
  }

  function encodeEdit(node, input) {
    var editor = editorFor(node);
    if (!editor) throw new EditError("That value can't be edited.");
    input = input == null ? "" : String(input);
    var trimmed = input.trim();

    switch (editor.type) {
      case "integer":
        if (!trimmed && node.kind === "nil") return encodeNil();
        if (trimmed.toLowerCase() === "nil") return encodeNil();
        if (!/^-?\d+$/.test(trimmed)) {
          throw new EditError("Enter a whole number, not \"" + trimmed + "\".");
        }
        return encodeInteger(parseInt(trimmed, 10));
      case "float":
        if (!/^-?\d*\.?\d+(e-?\d+)?$/i.test(trimmed)) {
          throw new EditError("Enter a number, not \"" + trimmed + "\".");
        }
        return encodeFloat(parseFloat(trimmed));
      case "boolean":
        return encodeBoolean(["true", "1", "on", "yes"].indexOf(trimmed.toLowerCase()) !== -1);
      case "string":
        return encodeString(input);
      case "symbol":
        return encodeSymbol(trimmed);
      default:
        throw new EditError("That value can't be edited.");
    }
  }

  /* Marshal writes a symbol out in full the first time and refers back to it by
   * position afterwards, so a symbol can't be rewritten where it sits: the
   * mention you want to change is often just a back-reference, and adding or
   * removing a definition renumbers every reference after it.
   *
   * So rather than patch one mention, rebuild them all. Walking the mentions in
   * order and re-deciding each one -- write it out, or point back at an earlier
   * one -- keeps the numbering right by construction. With nothing edited this
   * reproduces the original bytes exactly. */
  function symbolReplacements(scanner, symbolEdits) {
    var out = [];
    for (var d = 0; d < scanner.symbolRefs.length; d += 1) {
      var mentions = scanner.symbolRefs[d];
      var table = new Map();
      for (var i = 0; i < mentions.length; i += 1) {
        var node = mentions[i];
        var name = symbolEdits.has(node.start) ? symbolEdits.get(node.start) : node.value;
        var bytes;
        if (table.has(name)) {
          bytes = encodeSymbolLink(table.get(name));
        } else {
          table.set(name, table.size);
          bytes = encodeSymbol(name);
        }
        out.push({ start: node.start, finish: node.finish, bytes: bytes });
      }
    }
    return out;
  }

  function changed(node, input, data) {
    if (isSymbol(node)) return symbolName(input) !== node.value;
    var fresh = encodeEdit(node, input);
    var original = data.subarray(node.start, node.finish);
    if (fresh.length !== original.length) return true;
    for (var i = 0; i < fresh.length; i += 1) if (fresh[i] !== original[i]) return true;
    return false;
  }

  /* edits: Map of byte offset -> raw input string */
  function applyEdits(data, tree, edits) {
    var replacements = [];
    var symbolEdits = new Map();

    edits.forEach(function (input, offset) {
      var node = tree.node(offset);
      if (!node) throw new EditError("No value lives at byte " + offset + ".");
      var target = effective(node);
      if (isSymbol(target)) {
        symbolEdits.set(target.start, symbolName(input));
      } else {
        replacements.push({ start: target.start, finish: target.finish, bytes: encodeEdit(target, input) });
      }
    });

    if (symbolEdits.size) {
      replacements = replacements.concat(symbolReplacements(tree.scanner, symbolEdits));
    }

    replacements.sort(function (a, b) { return a.start - b.start; });

    var parts = [];
    var cursor = 0;
    for (var i = 0; i < replacements.length; i += 1) {
      var r = replacements[i];
      if (r.start < cursor) continue;
      parts.push(data.subarray(cursor, r.start));
      parts.push(r.bytes);
      cursor = r.finish;
    }
    parts.push(data.subarray(cursor));
    return concat(parts);
  }

  // -------------------------------------------------------------- highlights

  function ivarOf(node, name) {
    for (var i = 0; i < node.children.length; i += 1) {
      if (node.children[i][0] === name) return node.children[i][1];
    }
    return null;
  }

  function findObject(tree, test) {
    var found = null;
    tree.walk(tree.root, function (node) {
      if (found) return false;
      if ((node.kind === "object" || node.kind === "struct") && test(node)) {
        found = node;
        return false;
      }
    });
    return found;
  }

  function dataArray(tree, className) {
    var owner = findObject(tree, function (node) { return node.className === className; });
    if (!owner) return null;
    var array = ivarOf(owner, "@data");
    return array && array.kind === "array" ? array : null;
  }

  var PARTY_LIMIT = 60; // a party is six, but a save this page has never seen might not be

  function follow(tree, node) {
    var hops = 0;
    while (node && node.kind === "link" && hops < 8) {
      node = tree.scanner.objects[node.ref];
      hops += 1;
    }
    return node || null;
  }

  /* A party sits on the player, but the shape - an array held in @party - is
   * enough to find it in a save this page has never seen. */
  function partyList(tree, trainer) {
    var party = trainer ? ivarOf(trainer, "@party") : null;
    if (party && party.kind === "array") return party;
    var owner = findObject(tree, function (node) {
      var list = ivarOf(node, "@party");
      return list && list.kind === "array" && list.children.length > 0;
    });
    return owner ? ivarOf(owner, "@party") : null;
  }

  /* "43 fields" tells you nothing about which slot you are opening, so name
   * each one after its nickname, or failing that its species. Both are missing
   * often enough that the slot number has to stand on its own. */
  function slotLabel(tree, node, index) {
    var label = "Slot " + (index + 1);
    var mon = follow(tree, node);
    if (!mon || !mon.children.length) return label;

    var nickname = ivarOf(mon, "@name") || ivarOf(mon, "@nickname");
    if (nickname) nickname = effective(nickname);
    var species = ivarOf(mon, "@species");

    var name = null;
    if (nickname && nickname.kind === "string" && nickname.value) name = nickname.value;
    else if (species && isSymbol(species)) name = species.value;
    else if (species && species.kind === "int") name = "species " + species.value;
    return name ? label + " - " + name : label;
  }

  /* The parts people actually came to change, found by the shape of what they
   * hold rather than by save format version. */
  function highlights(tree) {
    var sections = [];
    var trainer = findObject(tree, function (node) {
      return ivarOf(node, "@money") && ivarOf(node, "@name");
    });

    if (trainer) {
      var fields = [];
      [["@name", "Name"], ["@money", "Money"], ["@coins", "Coins"],
       ["@soot", "Soot"], ["@id", "Trainer ID"]].forEach(function (pair) {
        var child = ivarOf(trainer, pair[0]);
        if (child && editable(child)) fields.push({ label: pair[1], node: child });
      });
      if (fields.length) sections.push({ id: "trainer", title: "Trainer", kind: "fields", fields: fields });
      sections.push({
        id: "player",
        title: trainer.className || "Player",
        kind: "node",
        node: trainer
      });
      var badges = ivarOf(trainer, "@badges");
      if (badges && badges.kind === "array") {
        sections.push({ id: "badges", title: "Badges", kind: "indexed", node: badges, prefix: "Badge" });
      }
    }

    var party = partyList(tree, trainer);
    if (party && party.children.length) {
      sections.push({
        id: "party",
        title: "Party",
        kind: "fields",
        fields: party.children.slice(0, PARTY_LIMIT).map(function (pair, i) {
          return { label: slotLabel(tree, pair[1], i), node: pair[1] };
        })
      });
    }

    var bag = trainer ? ivarOf(trainer, "@bag") : null;
    if (!bag || bag.kind !== "object") {
      bag = findObject(tree, function (node) { return ivarOf(node, "@pockets"); });
    }
    if (bag) sections.push({ id: "bag", title: "Bag", kind: "node", node: bag });

    var variables = dataArray(tree, "Game_Variables");
    if (variables) {
      sections.push({ id: "variables", title: "Variables", kind: "indexed", node: variables, prefix: "Variable" });
    }
    var switches = dataArray(tree, "Game_Switches");
    if (switches) {
      sections.push({ id: "switches", title: "Switches", kind: "indexed", node: switches, prefix: "Switch" });
    }
    return sections;
  }

  global.RX = {
    ROOT_ID: ROOT_ID,
    EditError: EditError,
    ParseError: ParseError,
    Scanner: Scanner,
    Tree: Tree,
    packLong: packLong,
    encodeInteger: encodeInteger,
    encodeString: encodeString,
    encodeSymbol: encodeSymbol,
    encodeFloat: encodeFloat,
    symbolName: symbolName,
    symbolReplacements: symbolReplacements,
    applyEdits: applyEdits,
    encodeEdit: encodeEdit,
    changed: changed,
    effective: effective,
    editable: editable,
    editorFor: editorFor,
    typeLabel: typeLabel,
    inputValue: inputValue,
    summary: summary,
    labelFor: labelFor,
    highlights: highlights,
    isSymbol: isSymbol,
    utf8: utf8
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
