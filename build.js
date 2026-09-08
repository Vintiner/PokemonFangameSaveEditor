/* Inlines the engine, styles and interface into one self-contained page, so
 * the result works from a static host or straight off the filesystem. */
const fs = require("fs");
const read = (p) => fs.readFileSync(__dirname + "/src/" + p, "utf8");

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Save editor for .rxdata files</title>
<style>
${read("style.css")}</style>
</head>
<body>
<div class="shell">
  <div class="masthead">
    <h1>Save editor</h1>
    <p>Edit values inside RPG Maker XP <code>.rxdata</code> saves \u2014 entirely in your browser</p>
  </div>
  <div id="app"></div>
</div>
<script>
${read("rxdata.js")}</script>
<script>
${read("ui.js")}</script>
</body>
</html>
`;

fs.mkdirSync(__dirname + "/build", { recursive: true });
fs.writeFileSync(__dirname + "/build/index.html", html);
console.log("build/index.html  " + (html.length / 1024).toFixed(0) + " KB");
