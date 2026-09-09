/* Checks the Party tab against a synthetic save, so it can run without a real
 * one: node test/make_fixture.js && node test/party_test.js */
const fs = require("fs");
const { JSDOM } = require("jsdom");

const SAVE = process.argv[2] || __dirname + "/fixture.rxdata";
const PAGE = __dirname + "/../build/index.html";

const fail = [];
let passed = 0;
function check(name, fn) {
  try {
    const result = fn();
    if (result === true) { passed += 1; console.log("  ok   " + name); }
    else { fail.push(name); console.log("  FAIL " + name + " -- " + result); }
  } catch (e) {
    fail.push(name);
    console.log("  FAIL " + name + " -- " + e.message);
  }
}

const saveBytes = fs.readFileSync(SAVE);
const dom = new JSDOM(fs.readFileSync(PAGE, "utf8"), { runScripts: "dangerously" });
const win = dom.window;
const doc = win.document;
win.scrollTo = function () {};

const text = () => doc.getElementById("app").textContent;
const tab = (title) =>
  Array.from(doc.querySelectorAll(".tab")).find((t) => t.textContent.trim().startsWith(title));
const click = (node) => node.dispatchEvent(new win.Event("click", { bubbles: true, cancelable: true }));
const rowFor = (label) =>
  Array.from(doc.querySelectorAll("tbody tr")).find(
    (tr) => tr.querySelector(".name") && tr.querySelector(".name").textContent.trim().startsWith(label)
  );

const input = doc.getElementById("file");
Object.defineProperty(input, "files", {
  value: [new win.File([saveBytes], "fixture.rxdata")],
  configurable: true
});
input.dispatchEvent(new win.Event("change", { bubbles: true }));

setTimeout(function () {
  check("there is a Party tab", () => !!tab("Party") || "missing");
  check("Party sits between Badges and Bag", () => {
    const titles = Array.from(doc.querySelectorAll(".tab")).map((t) => t.textContent.trim());
    return titles.join(",").includes("Badges,Party,Bag") || titles.join(",");
  });

  click(tab("Party"));
  check("the party tab lists a slot per Pokémon", () => {
    const rows = doc.querySelectorAll("tbody tr");
    return rows.length === 3 || rows.length + " rows";
  });
  check("a nicknamed slot is labelled with the nickname", () =>
    !!rowFor("Slot 1 - Sparky") || "no nickname label");
  check("an unnamed slot falls back to its species", () =>
    !!rowFor("Slot 2 - CHARIZARD") || "no species label");
  check("a slot shows the class it holds", () =>
    rowFor("Slot 1 - Sparky").textContent.includes("Pokemon") || "no type");
  check("a slot can be opened", () => {
    click(rowFor("Slot 1 - Sparky").querySelector("a"));
    return text().includes("species") || "no drill-down: " + text().slice(0, 120);
  });
  check("a value inside a Pokémon is editable", () => {
    const level = rowFor("level");
    return (level && level.querySelector("input").value === "42") || "no level field";
  });

  console.log("\n" + passed + " passed, " + fail.length + " failed");
  process.exit(fail.length ? 1 : 0);
}, 300);
