/* Writes a small Essentials-shaped save so the section finder can be exercised
 * without a real file. Symbols are written out in full each time, which a
 * reader accepts even though Ruby's writer would link them. */
const fs = require("fs");
require("../src/rxdata.js");

function bytes(list) {
  const out = [];
  list.forEach((part) => {
    if (typeof part === "number") out.push(part);
    else part.forEach((b) => out.push(b));
  });
  return out;
}

const long = (n) => Array.from(RX.packLong(n));
const int = (n) => Array.from(RX.encodeInteger(n));
const sym = (s) => Array.from(RX.encodeSymbol(s));
const str = (s) => Array.from(RX.encodeString(s));
const nil = [0x30];
const bool = (v) => [v ? 0x54 : 0x46];
const array = (items) => bytes([[0x5b], long(items.length), ...items]);
const object = (className, ivars) =>
  bytes([[0x6f], sym(className), long(ivars.length),
         ...ivars.map(([name, value]) => bytes([sym(name), value]))]);

const dump = (body) => bytes([[0x04, 0x08], body]);

function pokemon(species, name, level) {
  return object("Pokemon", [
    ["@species", sym(species)],
    ["@name", name === null ? nil : str(name)],
    ["@level", int(level)],
    ["@exp", int(level * level * level)],
    ["@happiness", int(70)]
  ]);
}

const bag = object("PokemonBag", [
  ["@pockets", array([array([]), array([array([sym("POTION"), int(3)])])])],
  ["@registeredIndex", int(0)]
]);

const trainer = object("Player", [
  ["@name", str("Red")],
  ["@money", int(31337)],
  ["@coins", int(120)],
  ["@id", int(65432)],
  ["@badges", array([bool(true), bool(true), bool(false), bool(false),
                     bool(false), bool(false), bool(false), bool(false)])],
  ["@party", array([
    pokemon("PIKACHU", "Sparky", 42),
    pokemon("CHARIZARD", null, 55),
    pokemon("SNORLAX", null, 30)
  ])],
  ["@bag", bag]
]);

const variables = object("Game_Variables", [
  ["@data", array([int(0), int(7), str("hello"), int(0)])]
]);
const switches = object("Game_Switches", [
  ["@data", array([nil, bool(true), bool(false)])]
]);

const file = bytes([dump(trainer), dump(variables), dump(switches)]);
fs.writeFileSync(__dirname + "/fixture.rxdata", Buffer.from(file));
console.log("test/fixture.rxdata  " + file.length + " bytes");
