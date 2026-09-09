# .rxdata save editor (static)

A static site for editing RPG Maker XP save files, with some presets built specifically for Essentials Fangames.

Everything runs in the browser. Your save is read by the page and never sent anywhere.



## Using it

Deployed to Github Pages: 


To use locally: Download the .zip file and unzip it. Open the `rxdata-save-editor.html` in a browser to begin editing.


## Tabs

**Trainer** is a curated pick of the fields people usually want; **Player** is the same
object in full. **Party**, **Bag**, **Badges**, **Variables** and **Switches** are found
by shape rather than by save format version, and are simply absent when a save has no
such thing. Party slots are named after the nickname or species they hold, and each one
opens into the Pokémon itself.
**All data** is the whole tree, and **Changes** lists what you have pending, where each
one can be held back or removed.

Edits save as you type them, leaving a field commits it, and nothing is lost when you
switch tabs.

## Searching

- **Text** - matched against field names and values: `money`, `Obstagoon`.
- **A byte offset** - `byte 15644`, `@15644` or `0x3D1C`, which finds the innermost value
  covering that offset.
- **A run of hex bytes** - `69 27 69 f3`.

Results show the path to each match, and every step of it is a link. Searching from
inside a value searches only that branch.

## Working on it

```
src/rxdata.js   the Marshal engine: reading, editing, search
src/ui.js       the interface
src/style.css   styles
build.js        inlines the three into build/index.html
test/engine_test.js  checks the engine against a reference Ruby implementation
test/ui_test.js      drives the built page in a headless DOM
test/make_fixture.js writes a small synthetic save
test/party_test.js   checks the Party tab against that fixture
```

```bash
node build.js
node test/engine_test.js path/to/save.rxdata   # needs Ruby, for the comparison
node test/ui_test.js     path/to/save.rxdata   # needs: npm install jsdom
node test/make_fixture.js && node test/party_test.js   # no save file needed
```

The engine tests apply the same edits with both this JavaScript engine and the Ruby
implementation and compare the results byte for byte, then load the patched save in
Ruby to confirm it still parses. The UI tests open a file, click through tabs, type into
fields, hold changes back, and check the bytes that come out of the download button.

## Limits

Numbers, text, names, yes/no values and empty slots are editable. Structural values -
lists, objects, and the packed binary blobs classes like `Table` use for map data - can
be browsed but not edited. Editing text that the file reuses elsewhere changes it
everywhere, since Marshal stores it once; names don't behave that way.

The page can't tell a real item name from a typo. If you invent a name the game doesn't
define, you get an item it doesn't recognise. Change one thing and load the save before
doing a batch.

## How was it built

Built with the help of Opus

Workflow:

Ruby script to modify one value -> Ruby on Rails application to modify multiple -> Tests added -> Ported to Javascript

