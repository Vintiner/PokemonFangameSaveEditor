/* Cross-checks the browser engine against the Ruby implementation.
 *   node test/engine_test.js path/to/save.rxdata
 * Reference bytes are produced by the Ruby side and compared byte for byte. */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

require("../src/rxdata.js");
const RX = globalThis.RX;

const SAVE = process.argv[2] || "/home/claude/rx/File_G.rxdata";
const RUBY_APP = "/home/claude/rxedit";

const pass = [];
const fail = [];

function check(name, fn) {
  try {
    const result = fn();
    if (result === true) {
      pass.push(name);
      console.log("  ok   " + name);
    } else {
      fail.push(name + ": " + result);
      console.log("  FAIL " + name + " -- " + result);
    }
  } catch (e) {
    fail.push(name + ": " + e.message);
    console.log("  FAIL " + name + " -- " + e.name + ": " + String(e.message).slice(0, 200));
  }
}

function same(a, b) {
  if (a.length !== b.length) return "lengths differ: " + a.length + " vs " + b.length;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return "first difference at byte " + i;
  }
  return true;
}

/* Runs the Ruby patcher with the same edits, so the two implementations can be
 * compared against each other rather than against my own expectations. */
function rubyPatch(edits) {
  const script = `
    require "${RUBY_APP}/lib/rxdata/scanner"
    require "${RUBY_APP}/lib/rxdata/patcher"
    require "${RUBY_APP}/lib/rxdata/presenter"
    require "${RUBY_APP}/lib/rxdata/tree"
    data = File.binread(${JSON.stringify(SAVE)})
    tree = Rxdata::Tree.new(data)
    edits = JSON.parse(${JSON.stringify(JSON.stringify(edits))})
    $stdout.binmode
    $stdout.write Rxdata::Patcher.apply(data, tree.scanner, edits)
  `;
  return new Uint8Array(execFileSync("ruby", ["-rjson", "-e", script], {
    maxBuffer: 64 * 1024 * 1024,
    encoding: "buffer"
  }));
}

const data = new Uint8Array(fs.readFileSync(SAVE));
const tree = new RX.Tree(data);

console.log("\n== packed integers match Ruby ==");
check("pack_long agrees with Ruby across boundary values", () => {
  const values = [0, 1, 122, 123, 255, 256, 65535, 65536, 16777216, 1073741823,
                  -1, -123, -124, -255, -256, -65536, -1073741824];
  const script = `
    values = ${JSON.stringify(values)}
    print values.map { |v| Marshal.dump(v).byteslice(2..).unpack1("H*") }.join(",")
  `;
  const expected = execFileSync("ruby", ["-e", script], { encoding: "utf8" }).split(",");
  const got = values.map((v) => Buffer.from(RX.encodeInteger(v)).toString("hex"));
  for (let i = 0; i < values.length; i += 1) {
    if (got[i] !== expected[i]) {
      return values[i] + " encoded as " + got[i] + ", Ruby says " + expected[i];
    }
  }
  return true;
});

check("oversized integers are refused", () => {
  try {
    RX.encodeInteger(Math.pow(2, 30));
    return "no error raised";
  } catch (e) {
    return e.name === "EditError";
  }
});

console.log("\n== reading the save ==");
const stats = tree.stats();
console.log("  (" + stats.values + " values, " + stats.bytes + " bytes, " + stats.dumps + " section(s))");

check("the whole file is consumed", () => stats.trailing === 0 || stats.trailing + " bytes left over");

check("the value count matches the Ruby scanner", () => {
  const script = `
    require "${RUBY_APP}/lib/rxdata/scanner"
    require "${RUBY_APP}/lib/rxdata/patcher"
    require "${RUBY_APP}/lib/rxdata/presenter"
    require "${RUBY_APP}/lib/rxdata/tree"
    tree = Rxdata::Tree.new(File.binread(${JSON.stringify(SAVE)}))
    print tree.stats[:values]
  `;
  const expected = parseInt(execFileSync("ruby", ["-e", script], { encoding: "utf8" }), 10);
  return stats.values === expected || "JS found " + stats.values + ", Ruby found " + expected;
});

check("re-splicing with no edits reproduces the file", () =>
  same(RX.applyEdits(data, tree, new Map()), data));

check("rebuilding every symbol mention with nothing edited reproduces the file", () => {
  const replacements = RX.symbolReplacements(tree.scanner, new Map());
  const out = new Uint8Array(data);
  replacements.forEach((r) => {
    if (r.bytes.length !== r.finish - r.start) throw new Error("length changed at " + r.start);
    out.set(r.bytes, r.start);
  });
  return same(out, data);
});

console.log("\n== the same edits, both engines ==");
const variables = tree.children(tree.node(2)).find((pair) => pair[0] === ":variables");
const varData = tree.children(variables[1]).find((pair) => pair[0] === "@data")[1];
const var16 = varData.children[16][1];

check("variable 16 reads the same value Ruby reads", () => var16.value === 34 || var16.value);

check("editing a number produces byte-identical output to Ruby", () => {
  const edits = new Map([[var16.start, "77"]]);
  return same(RX.applyEdits(data, tree, edits), rubyPatch({ [var16.start]: "77" }));
});

check("editing a number touches exactly one byte", () => {
  const out = RX.applyEdits(data, tree, new Map([[var16.start, "77"]]));
  let differing = 0;
  for (let i = 0; i < data.length; i += 1) if (data[i] !== out[i]) differing += 1;
  return (out.length === data.length && differing === 1) || differing + " bytes differ";
});

const player = tree.children(tree.node(2)).find((pair) => pair[0] === ":player")[1];
const nameNode = RX.effective(tree.children(player).find((pair) => pair[0] === "@name")[1]);
const moneyNode = tree.children(player).find((pair) => pair[0] === "@money")[1];

check("editing text produces byte-identical output to Ruby", () => {
  const edits = { [nameNode.start]: "Longer Name" };
  return same(RX.applyEdits(data, tree, new Map(Object.entries(edits).map(([k, v]) => [Number(k), v]))),
              rubyPatch(edits));
});

check("editing several values at once matches Ruby", () => {
  const edits = { [var16.start]: "55", [moneyNode.start]: "12345", [nameNode.start]: "Ada" };
  const map = new Map(Object.entries(edits).map(([k, v]) => [Number(k), v]));
  return same(RX.applyEdits(data, tree, map), rubyPatch(edits));
});

console.log("\n== symbols ==");
const bag = tree.children(tree.node(2)).find((pair) => pair[0] === ":bag")[1];
const pockets = tree.children(bag).find((pair) => pair[0] === "@pockets")[1];
const items = [];
tree.children(pockets).forEach((pair) => {
  tree.children(pair[1]).forEach((entry) => {
    const first = tree.children(entry[1])[0];
    if (first) items.push(first[1]);
  });
});
const backReferenced = items.find((n) => n.kind === "symlink");
const spelledOut = items.find((n) => n.kind === "symbol");

check("the bag holds both a spelled-out name and a back-reference", () =>
  (!!backReferenced && !!spelledOut) || "did not find both");

check("a back-referenced name is editable", () => RX.editable(backReferenced) || "read-only");

check("editing a back-referenced name matches Ruby byte for byte", () => {
  const edits = { [backReferenced.start]: "MASTERBALL" };
  const map = new Map([[backReferenced.start, "MASTERBALL"]]);
  return same(RX.applyEdits(data, tree, map), rubyPatch(edits));
});

check("editing a spelled-out name matches Ruby byte for byte", () => {
  const edits = { [spelledOut.start]: "MAXPOTION" };
  const map = new Map([[spelledOut.start, "MAXPOTION"]]);
  return same(RX.applyEdits(data, tree, map), rubyPatch(edits));
});

check("names Marshal can't hold are refused", () => {
  const bad = ["", "   ", "SUPER POTION", "POTIÓN"];
  const refused = bad.filter((name) => {
    try {
      RX.applyEdits(data, tree, new Map([[backReferenced.start, name]]));
      return false;
    } catch (e) {
      return e.name === "EditError";
    }
  });
  return refused.length === 4 || "only " + refused.length + " of 4 refused";
});

console.log("\n== the patched save still loads in Ruby ==");
check("a patched save loads with the new values", () => {
  const map = new Map([[var16.start, "55"], [backReferenced.start, "MASTERBALL"]]);
  const out = RX.applyEdits(data, tree, map);
  const tmp = path.join(require("os").tmpdir(), "rx-js-patched.rxdata");
  fs.writeFileSync(tmp, Buffer.from(out));
  const script = `
    def stub(p); parent = Object; p.split("::").each { |x|
      parent = parent.const_defined?(x, false) ? parent.const_get(x, false) : parent.const_set(x, Class.new) }; end
    bytes = File.binread(${JSON.stringify(tmp)})
    save = nil
    500.times do
      begin
        save = Marshal.load(bytes); break
      rescue => e
        case e.message
        when %r{undefined class/module ([\\w:]+)}, /uninitialized constant ([\\w:]+)/ then stub($1.sub(/::\\z/, ""))
        when /class ([\\w:]+) needs to have method \`_load'/
          Object.const_get($1).class_eval do
            def self._load(r) = allocate.tap { |o| o.instance_variable_set(:@__raw, r) }
            def _dump(_d) = instance_variable_get(:@__raw)
          end
        else raise
        end
      end
    end
    pockets = save[:bag].instance_variable_get(:@pockets)
    pockets = pockets.values if pockets.is_a?(Hash)
    names = pockets.flatten(1).select { |e| e.is_a?(Array) }.map(&:first)
    print [save[:variables].instance_variable_get(:@data)[16],
           names.include?(:MASTERBALL),
           save[:player].instance_variable_get(:@money)].join(",")
  `;
  const result = execFileSync("ruby", ["-e", script], { encoding: "utf8" });
  return result === "55,true,206554" || "Ruby read back: " + result;
});

console.log("\n== search ==");
check("text search finds a value", () => tree.search("OBSTAGOON").length > 0 || "nothing found");
check("byte offset search finds the value at that offset", () => {
  const hits = tree.search("byte " + var16.start);
  return (hits.length === 1 && hits[0] === var16) || "found " + hits.length;
});
check("hex offset search works", () => {
  const hits = tree.search("0x" + var16.start.toString(16));
  return (hits.length === 1 && hits[0] === var16) || "found " + hits.length;
});
check("a run of hex bytes is found", () => {
  const hits = tree.search("69 27 69 f3");
  return hits.indexOf(var16) !== -1 || "not found";
});
check("a scoped search returns fewer matches than the whole file", () => {
  const scoped = tree.search("money", player).length;
  const whole = tree.search("money").length;
  return (scoped > 0 && scoped < whole) || "scoped " + scoped + " vs whole " + whole;
});

console.log("\n== shortcuts ==");
const sections = RX.highlights(tree);
check("the expected tabs are found", () => {
  const ids = sections.map((s) => s.id).join(",");
  return ids === "trainer,player,badges,bag,variables,switches" || "got " + ids;
});
check("paths are made of linkable steps", () => {
  const parts = tree.pathParts(items[0]);
  return parts.length >= 4 && parts[0].label === "File" ||
    "got " + JSON.stringify(parts.map((p) => p.label));
});

console.log("\n" + pass.length + " passed, " + fail.length + " failed");
fail.forEach((f) => console.log("  - " + f));
process.exit(fail.length ? 1 : 0);
