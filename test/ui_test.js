/* Drives the built page in a DOM: open a file, click tabs, type into fields,
 * and check what comes out of the download button.
 *   node test/ui_test.js path/to/save.rxdata */
const fs = require("fs");
const { execFileSync } = require("child_process");
const { JSDOM } = require("jsdom");

const SAVE = process.argv[2] || "/home/claude/rx/File_G.rxdata";
const PAGE = __dirname + "/../build/index.html";

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
    console.log("  FAIL " + name + " -- " + e.name + ": " + String(e.message).slice(0, 300));
  }
}

const saveBytes = fs.readFileSync(SAVE);
const dom = new JSDOM(fs.readFileSync(PAGE, "utf8"), { runScripts: "dangerously" });
const win = dom.window;
const doc = win.document;

// jsdom has no object URLs; capture what the page tries to hand back instead.
const downloads = [];
win.URL.createObjectURL = function (blob) {
  downloads.push(blob);
  return "blob:captured/" + downloads.length;
};
win.URL.revokeObjectURL = function () {};
win.HTMLAnchorElement.prototype.click = function () {};
win.alert = function (message) { downloads.push(new Error(message)); };
win.scrollTo = function () {}; // jsdom has no layout

function text() {
  return doc.getElementById("app").textContent;
}

function tab(title) {
  return Array.from(doc.querySelectorAll(".tab")).find((t) => t.textContent.trim().startsWith(title));
}

function click(node) {
  node.dispatchEvent(new win.Event("click", { bubbles: true, cancelable: true }));
}

function rowFor(label) {
  return Array.from(doc.querySelectorAll("tbody tr")).find(
    (tr) => tr.querySelector(".name") && tr.querySelector(".name").textContent.trim().startsWith(label)
  );
}

function setField(row, value) {
  const input = row.querySelector("input, select");
  input.value = value;
  input.dispatchEvent(new win.Event("change", { bubbles: true }));
  return input;
}

async function blobBytes(blob) {
  return new Uint8Array(await blob.arrayBuffer());
}

// jsdom won't accept a plain array for input.files, so stand in for the
// FileList the browser would provide.
function setFiles(input, file) {
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  input.dispatchEvent(new win.Event("change", { bubbles: true }));
}

function button(label) {
  return Array.from(doc.querySelectorAll("button")).find((b) => b.textContent.trim() === label);
}

(async function run() {
  console.log("\n== opening a file ==");
  check("the page starts on the upload screen", () =>
    text().includes("Open a save file") || "no upload screen");

  const file = new win.File([saveBytes], "My Save File.rxdata", { type: "application/octet-stream" });
  setFiles(doc.getElementById("file"), file);
  await new Promise((r) => setTimeout(r, 300));

  check("the file is read and the readout appears", () =>
    text().includes("137,338 bytes") || "readout missing: " + text().slice(0, 120));
  check("the original filename is kept", () =>
    text().includes("My Save File.rxdata") || "name missing");
  check("the value count is shown", () =>
    text().includes("19017 values") || "count missing");

  console.log("\n== tabs ==");
  ["Trainer", "Player", "Badges", "Party", "Bag", "Variables", "Switches", "All data", "Changes"]
    .forEach((title) => {
      check("there is a " + JSON.stringify(title) + " tab", () => !!tab(title) || "missing");
    });
  check("the first tab is active on open", () =>
    doc.querySelector(".tab.active").textContent.trim() === "Trainer" ||
    doc.querySelector(".tab.active").textContent);
  check("the trainer tab shows money", () => !!rowFor("Money") || "no money row");

  console.log("\n== editing ==");
  click(tab("Variables"));
  check("the variables tab lists variables", () => !!rowFor("Variable 16") || "no variables");

  const row16 = rowFor("Variable 16");
  check("a variable shows its current value", () =>
    row16.querySelector("input").value === "34" || row16.querySelector("input").value);

  setField(row16, "77");
  check("editing a field marks the row as changed", () =>
    rowFor("Variable 16").className.includes("changed") || "not marked");
  check("the row shows what the value was", () =>
    rowFor("Variable 16").textContent.includes("was 34") || "no before value");
  check("the pending count updates without leaving the page", () =>
    doc.querySelector(".actionbar .count").textContent.includes("1 change") ||
    doc.querySelector(".actionbar .count").textContent);
  check("the changes tab gains a count", () =>
    !!doc.querySelector(".tab-changes .pill") || "no pill");

  setField(rowFor("Variable 16"), "banana");
  check("a nonsense number is refused inline", () =>
    rowFor("Variable 16").textContent.includes("whole number") || "no error shown");
  check("a refused edit is not counted", () =>
    doc.querySelector(".actionbar .count").textContent.includes("1 change") || "count changed");

  setField(rowFor("Variable 16"), "34");
  check("typing the original value back clears the change", () =>
    doc.querySelector(".actionbar .count").textContent.includes("save as you make them") ||
    doc.querySelector(".actionbar .count").textContent);

  setField(rowFor("Variable 16"), "55");

  console.log("\n== edits survive moving between tabs ==");
  click(tab("Trainer"));
  click(tab("Variables"));
  check("the change is still there after switching tabs", () =>
    rowFor("Variable 16").querySelector("input").value === "55" || "value lost");
  check("the change is still counted", () =>
    doc.querySelector(".actionbar .count").textContent.includes("1 change") || "count lost");

  console.log("\n== the party ==");
  click(tab("Party"));
  check("the party tab lists a first slot", () => !!rowFor("Slot 1") || "no slot rows");
  check("the first slot names what it holds", () =>
    rowFor("Slot 1").querySelector(".name").textContent.trim().length > "Slot 1".length ||
    "slot has no name");
  click(rowFor("Slot 1").querySelector("a"));
  check("a slot can be opened", () => text().includes("species") || "no drill-down");

  console.log("\n== the bag ==");
  click(tab("Bag"));
  check("the bag tab opens", () => !!rowFor("pockets") || "no pockets row");
  click(rowFor("pockets").querySelector("a"));
  check("pockets can be browsed into", () => text().includes("List of") || "no drill-down");

  console.log("\n== search ==");
  const box = doc.querySelector('input[type="search"]');
  box.value = "POKEBALL";
  click(button("Search"));
  check("search finds the item", () => text().includes("POKEBALL") || "not found");
  check("search results show a clickable path", () => {
    const links = doc.querySelectorAll(".path a");
    return links.length >= 2 || "only " + links.length + " path links";
  });

  const ballRow = Array.from(doc.querySelectorAll("tbody tr")).find(
    (tr) => tr.querySelector("input") && tr.querySelector("input").value === "POKEBALL"
  );
  check("a back-referenced item is editable in the page", () => !!ballRow || "no editable POKEBALL row");
  setField(ballRow, "MASTERBALL");
  check("editing an item is counted", () =>
    doc.querySelector(".actionbar .count").textContent.includes("2 changes") ||
    doc.querySelector(".actionbar .count").textContent);

  box.value = "byte 15644";
  click(button("Search"));
  check("a byte offset can be searched", () => text().includes("1 match") || "offset search failed");

  console.log("\n== the changes list ==");
  click(tab("Changes"));
  check("both changes are listed", () => {
    const rows = doc.querySelectorAll("tbody tr");
    return rows.length === 2 || rows.length + " rows";
  });
  check("each change shows before and after", () => text().includes("→") || "no arrow");
  check("each change shows its path", () => !!doc.querySelector(".path a") || "no path");

  const firstBox = doc.querySelector('input[type="checkbox"]');
  firstBox.checked = false;
  firstBox.dispatchEvent(new win.Event("change", { bubbles: true }));
  check("unticking a change holds it back", () =>
    doc.querySelector(".actionbar .count").textContent.includes("held back") ||
    doc.querySelector(".actionbar .count").textContent);

  console.log("\n== downloading ==");
  click(button("Download patched save"));
  const held = await blobBytes(downloads[downloads.length - 1]);
  check("a held-back change is left out of the download", () => {
    return (held[15645] === 34 + 5) || "variable 16 byte is " + held[15645];
  });

  firstBox.checked = true;
  firstBox.dispatchEvent(new win.Event("change", { bubbles: true }));
  click(button("Download patched save"));
  const patched = await blobBytes(downloads[downloads.length - 1]);

  check("the download is a whole save file", () =>
    patched.length >= saveBytes.length - 8 || "only " + patched.length + " bytes");

  check("the downloaded save loads in Ruby with both edits", () => {
    const tmp = "/tmp/rx-static-patched.rxdata";
    fs.writeFileSync(tmp, Buffer.from(patched));
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
             save[:player].instance_variable_get(:@money),
             save[:player].instance_variable_get(:@party).first.instance_variable_get(:@species)].join(",")
    `;
    const result = execFileSync("ruby", ["-e", script], { encoding: "utf8" });
    return result === "55,true,206554,OBSTAGOON" || "Ruby read back: " + result;
  });

  click(button("Discard all"));
  check("discarding empties the list", () =>
    doc.querySelector(".actionbar .count").textContent.includes("save as you make them") ||
    doc.querySelector(".actionbar .count").textContent);

  click(button("Download original"));
  const original = await blobBytes(downloads[downloads.length - 1]);
  check("the original download matches the file that was opened", () => {
    if (original.length !== saveBytes.length) return "length differs";
    for (let i = 0; i < original.length; i += 1) {
      if (original[i] !== saveBytes[i]) return "differs at byte " + i;
    }
    return true;
  });

  console.log("\n== a file that isn't a save ==");
  const junk = new win.File([Buffer.from("not a marshal stream")], "junk.rxdata");
  click(button("Open a different save"));
  setFiles(doc.getElementById("file"), junk);
  await new Promise((r) => setTimeout(r, 200));
  check("a file that isn't a Marshal stream is refused with an explanation", () =>
    text().includes("Marshal") || "no explanation: " + text().slice(0, 150));

  console.log("\n" + pass.length + " passed, " + fail.length + " failed");
  fail.forEach((f) => console.log("  - " + f));
  process.exit(fail.length ? 1 : 0);
})();
