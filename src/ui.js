/* The interface. Everything happens in the page: the save is read with
 * FileReader, edited in memory, and handed back as a download. Nothing is
 * uploaded anywhere, so there is no session to expire and no server to trust. */
(function () {
  "use strict";

  var INDEXED_LIMIT = 300;
  var state = {
    name: null,
    data: null,
    tree: null,
    edits: new Map(), // offset -> { value, enabled }
    tab: null,
    at: null,
    query: null,
    scope: null
  };

  var app = document.getElementById("app");

  // ------------------------------------------------------------- small tools

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (key) {
      if (key === "class") node.className = attrs[key];
      else if (key === "text") node.textContent = attrs[key];
      else if (key.slice(0, 2) === "on") node.addEventListener(key.slice(2), attrs[key]);
      else if (attrs[key] !== null && attrs[key] !== undefined) node.setAttribute(key, attrs[key]);
    });
    (children || []).forEach(function (child) {
      if (child === null || child === undefined) return;
      node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    });
    return node;
  }

  function truncate(text, limit) {
    text = String(text === null || text === undefined ? "" : text);
    return text.length > limit ? text.slice(0, limit) + "…" : text;
  }

  function plural(count, word) {
    return count + " " + word + (count === 1 ? "" : "s");
  }

  function enabledEdits() {
    var out = new Map();
    state.edits.forEach(function (entry, offset) {
      if (entry.enabled) out.set(offset, entry.value);
    });
    return out;
  }

  function download(bytes, filename) {
    var url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
    var link = el("a", { href: url, download: filename });
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function go(view) {
    Object.keys(view).forEach(function (key) { state[key] = view[key]; });
    render();
    window.scrollTo(0, 0);
  }

  // ---------------------------------------------------------------- the file

  function openFile(file) {
    var reader = new FileReader();
    reader.onload = function () {
      var bytes = new Uint8Array(reader.result);
      try {
        var tree = new RX.Tree(bytes);
        state.name = file.name;
        state.data = bytes;
        state.tree = tree;
        state.edits = new Map();
        state.tab = null;
        state.at = null;
        state.query = null;
        state.scope = null;
        render();
      } catch (e) {
        renderUpload(e.message || "That file could not be read.");
      }
    };
    reader.onerror = function () { renderUpload("That file could not be read."); };
    reader.readAsArrayBuffer(file);
  }

  // ----------------------------------------------------------------- editing

  function rowFor(label, node) {
    var target = RX.effective(node);
    var entry = state.edits.get(target.start);
    var isEditable = RX.editable(target);
    return {
      node: node,
      target: target,
      label: label,
      type: RX.typeLabel(node),
      summary: RX.summary(node, state.tree),
      editable: isEditable,
      container: !isEditable && RX.effective(node).children.length > 0,
      value: entry ? entry.value : RX.inputValue(target),
      original: RX.inputValue(target),
      pending: !!entry,
      offset: target.start
    };
  }

  function commitEdit(row, input, errorSlot) {
    var value = input.value;
    try {
      RX.encodeEdit(row.target, value); // rejects anything unwritable
      if (RX.changed(row.target, value, state.data)) {
        var existing = state.edits.get(row.offset);
        state.edits.set(row.offset, {
          value: value,
          enabled: existing ? existing.enabled : true
        });
      } else {
        state.edits.delete(row.offset);
      }
      errorSlot.textContent = "";
      errorSlot.className = "field-error";
      paintRow(row, input, errorSlot);
      paintCounts();
    } catch (e) {
      errorSlot.textContent = e.message;
      errorSlot.className = "field-error showing";
    }
  }

  function paintRow(row, input, errorSlot) {
    var entry = state.edits.get(row.offset);
    var tr = input.closest("tr");
    tr.className = entry ? "row changed" : "row";
    var was = tr.querySelector(".was");
    if (entry) {
      if (!was) {
        was = el("span", { class: "was" });
        input.parentNode.insertBefore(was, errorSlot);
      }
      was.textContent = "was " + truncate(row.original, 40);
    } else if (was) {
      was.remove();
    }
  }

  function paintCounts() {
    var included = 0;
    state.edits.forEach(function (entry) { if (entry.enabled) included += 1; });
    var count = document.querySelector(".actionbar .count");
    if (count) {
      count.innerHTML = "";
      if (state.edits.size) {
        var held = state.edits.size - included;
        count.appendChild(el("b", { text: plural(included, "change") }));
        count.appendChild(document.createTextNode(
          " will be applied" + (held ? ", " + held + " held back" : "") + "."
        ));
      } else {
        count.textContent = "Changes save as you make them.";
      }
    }
    var pill = document.querySelector(".tab-changes .pill");
    var tab = document.querySelector(".tab-changes");
    if (tab) {
      if (state.edits.size && !pill) tab.appendChild(el("span", { class: "pill", text: String(state.edits.size) }));
      else if (state.edits.size && pill) pill.textContent = String(state.edits.size);
      else if (pill) pill.remove();
    }
    var discard = document.querySelector(".discard-all");
    if (discard) discard.style.display = state.edits.size ? "" : "none";
  }

  // ----------------------------------------------------------------- drawing

  function renderUpload(error) {
    app.innerHTML = "";
    var input = el("input", { type: "file", accept: ".rxdata,.rvdata,.rvdata2", id: "file" });
    input.addEventListener("change", function () {
      if (input.files && input.files[0]) openFile(input.files[0]);
    });

    var drop = el("div", { class: "dropzone" }, [
      el("p", { text: "Drop a save file here, or choose one:" }),
      input
    ]);
    drop.addEventListener("dragover", function (e) { e.preventDefault(); drop.classList.add("over"); });
    drop.addEventListener("dragleave", function () { drop.classList.remove("over"); });
    drop.addEventListener("drop", function (e) {
      e.preventDefault();
      drop.classList.remove("over");
      if (e.dataTransfer.files && e.dataTransfer.files[0]) openFile(e.dataTransfer.files[0]);
    });

    app.appendChild(el("div", { class: "panel" }, [
      el("h2", { text: "Open a save file" }),
      el("div", { class: "panel-body lede" }, [
        el("p", { text: "Browse everything inside an RPG Maker XP .rxdata save and change the " +
                        "values you care about \u2014 money, variables, switches, names, bag items, " +
                        "party data. Your file is read in this page and never leaves your computer." }),
        error ? el("p", { class: "flash alert", text: error }) : null,
        drop
      ])
    ]));

    app.appendChild(el("div", { class: "panel" }, [
      el("h2", { text: "How editing works" }),
      el("div", { class: "panel-body" }, [
        el("ol", { class: "steps" }, [
          el("li", { text: "The file is read as a Ruby Marshal stream, the format RPG Maker XP and " +
                           "Pokémon Essentials use, and every value is located down to its exact byte range." }),
          el("li", { text: "Changing a value rewrites only that value's bytes. The rest is copied " +
                           "through untouched, so a save from a game this page has never seen still " +
                           "comes out intact." }),
          el("li", { text: "Changes that would break the file's internal references are refused " +
                           "rather than written." })
        ])
      ])
    ]));
  }

  function sections() {
    return RX.highlights(state.tree);
  }

  function tabsFor(list) {
    var tabs = list.map(function (s) { return { id: s.id, title: s.title }; });
    tabs.push({ id: "all", title: "All data" });
    tabs.push({ id: "changes", title: "Changes" });
    return tabs;
  }

  function renderTabs(list) {
    var nav = el("nav", { class: "tabs", "aria-label": "Sections of this save" });
    tabsFor(list).forEach(function (tab) {
      var active = tab.id === state.tab;
      var node = el("a", {
        href: "#",
        class: "tab" + (active ? " active" : "") + (tab.id === "changes" ? " tab-changes" : ""),
        "aria-current": active ? "page" : null,
        onclick: function (e) { e.preventDefault(); go({ tab: tab.id, at: null, query: null, scope: null }); }
      }, [tab.title]);
      if (tab.id === "changes" && state.edits.size) {
        node.appendChild(el("span", { class: "pill", text: String(state.edits.size) }));
      }
      nav.appendChild(node);
    });
    return nav;
  }

  function pathSpan(node) {
    var span = el("span", { class: "path" });
    state.tree.pathParts(node).forEach(function (part, i) {
      if (i) span.appendChild(document.createTextNode(" / "));
      span.appendChild(el("a", {
        href: "#",
        text: part.label,
        onclick: function (e) { e.preventDefault(); go({ tab: "all", at: part.offset, query: null }); }
      }));
    });
    return span;
  }

  function renderRows(rows, showPath) {
    var body = el("tbody");
    rows.forEach(function (row) {
      var name = el("td", { class: "name" });
      if (row.container) {
        name.appendChild(el("a", {
          href: "#",
          text: row.label,
          onclick: function (e) { e.preventDefault(); go({ tab: "all", at: row.offset, query: null }); }
        }));
      } else {
        name.appendChild(document.createTextNode(row.label));
      }
      if (showPath) name.appendChild(pathSpan(row.node));

      var valueCell = el("td");
      if (row.editable) {
        var errorSlot = el("span", { class: "field-error" });
        var input;
        if (row.target.kind === "true" || row.target.kind === "false") {
          input = el("select", {}, [
            el("option", { value: "true", text: "true" }),
            el("option", { value: "false", text: "false" })
          ]);
          input.value = row.value;
        } else {
          input = el("input", { type: "text", value: row.value, autocomplete: "off" });
        }
        input.addEventListener("change", function () { commitEdit(row, input, errorSlot); });
        valueCell.appendChild(input);
        if (row.pending) valueCell.appendChild(el("span", { class: "was", text: "was " + truncate(row.original, 40) }));
        valueCell.appendChild(errorSlot);
      } else {
        valueCell.appendChild(el("span", { class: "value-mono", text: truncate(row.summary, 90) }));
      }

      var location = el("td", { class: "offset" });
      if (row.offset >= 0) {
        location.appendChild(el("span", { text: "byte " + row.offset }));
        if (!row.container) {
          location.appendChild(el("span", {
            class: "offset-hex",
            text: "0x" + row.offset.toString(16).toUpperCase()
          }));
        }
      }

      body.appendChild(el("tr", { class: row.pending ? "row changed" : "row" }, [
        name, el("td", { class: "type", text: row.type }), valueCell, location
      ]));
    });

    return el("table", {}, [
      el("thead", {}, [el("tr", {}, [
        el("th", { scope: "col", text: "Name" }),
        el("th", { scope: "col", text: "Type" }),
        el("th", { scope: "col", text: "Value" }),
        el("th", { scope: "col", text: "Location" })
      ])]),
      body
    ]);
  }

  function sectionRows(section) {
    if (section.kind === "fields") {
      return section.fields.map(function (field) { return rowFor(field.label, field.node); });
    }
    if (section.kind === "indexed") {
      return section.node.children.slice(0, INDEXED_LIMIT).map(function (pair, i) {
        return rowFor(section.prefix + " " + i, pair[1]);
      });
    }
    return state.tree.children(section.node).slice(0, INDEXED_LIMIT).map(function (pair) {
      return rowFor(RX.labelFor(pair[0], pair[1]), pair[1]);
    });
  }

  function renderChanges() {
    var panel = el("div", { class: "panel" }, [el("h2", { text: "Pending changes" })]);
    if (!state.edits.size) {
      panel.appendChild(el("div", { class: "panel-body" }, [
        el("p", { class: "lede", text: "No changes yet. Edit a value on any tab and it will be listed here." })
      ]));
      return panel;
    }

    var body = el("tbody");
    Array.from(state.edits.keys()).sort(function (a, b) { return a - b; }).forEach(function (offset) {
      var entry = state.edits.get(offset);
      var node = state.tree.node(offset);
      if (!node) return;

      var include = el("input", { type: "checkbox", "aria-label": "Include this change" });
      include.checked = entry.enabled;
      include.addEventListener("change", function () {
        entry.enabled = include.checked;
        render();
      });

      var name = el("td", { class: "name" }, [
        el("a", {
          href: "#",
          text: state.tree.label(node),
          onclick: function (e) { e.preventDefault(); go({ tab: "all", at: offset, query: null }); }
        }),
        pathSpan(node)
      ]);

      var change = el("td", { class: "value-mono" }, [
        el("span", { class: "was-inline", text: truncate(RX.inputValue(node), 40) }),
        el("span", { class: "arrow", text: " → " }),
        el("b", { text: truncate(entry.value, 40) }),
        el("span", { class: "offset", text: "byte " + offset })
      ]);

      var remove = el("button", {
        class: "btn link",
        text: "Remove",
        onclick: function () { state.edits.delete(offset); render(); }
      });

      body.appendChild(el("tr", { class: entry.enabled ? "row" : "row muted" }, [
        el("td", {}, [include]), name, change, el("td", {}, [remove])
      ]));
    });

    panel.appendChild(el("table", {}, [
      el("thead", {}, [el("tr", {}, [
        el("th", { scope: "col", text: "Include" }),
        el("th", { scope: "col", text: "Value" }),
        el("th", { scope: "col", text: "Change" }),
        el("th", { scope: "col", text: "" })
      ])]),
      body
    ]));
    return panel;
  }

  function renderSearch() {
    var scopeNode = state.scope !== null ? state.tree.node(state.scope) : null;
    var results = state.tree.search(state.query, scopeNode);
    var wrap = document.createDocumentFragment();

    var note = el("div", { class: "crumbs" });
    if (scopeNode) {
      note.appendChild(document.createTextNode("Searching inside "));
      note.appendChild(el("b", { text: state.tree.label(scopeNode) }));
      note.appendChild(document.createTextNode(" - "));
      note.appendChild(el("a", {
        href: "#",
        text: "search the whole file instead",
        onclick: function (e) { e.preventDefault(); go({ scope: null }); }
      }));
    } else {
      note.appendChild(document.createTextNode(
        "Searching the whole file. Try a name, a value, byte 15644, 0x3D1C, or a run of hex like 69 27 69."
      ));
    }
    wrap.appendChild(note);

    var panel = el("div", { class: "panel" }, [
      el("h2", { text: plural(results.length, "match") + " for \u201c" + state.query + "\u201d" })
    ]);
    if (results.length) {
      panel.appendChild(renderRows(results.map(function (node) {
        return rowFor(state.tree.label(node), node);
      }), true));
      panel.appendChild(el("p", {
        class: "panel-note",
        text: "Matches are capped at 200. Narrow the search if what you want isn't here."
      }));
    } else {
      panel.appendChild(el("div", { class: "panel-body" }, [
        el("p", { class: "lede", text: "Nothing matched. Try part of a name, a value you can see in the game, or a byte offset." })
      ]));
    }
    wrap.appendChild(panel);
    return wrap;
  }

  function renderTree() {
    var node = state.at === null ? state.tree.root : state.tree.node(state.at);
    if (!node) node = state.tree.root;

    var crumbs = el("div", { class: "crumbs" });
    state.tree.breadcrumbs(node).forEach(function (crumb, i) {
      if (i) crumbs.appendChild(el("span", { text: "/" }));
      if (crumb === node) {
        crumbs.appendChild(el("b", { text: state.tree.label(crumb) }));
      } else {
        crumbs.appendChild(el("a", {
          href: "#",
          text: state.tree.label(crumb),
          onclick: function (e) { e.preventDefault(); go({ tab: "all", at: crumb.start }); }
        }));
      }
    });
    if (node !== state.tree.root) {
      crumbs.appendChild(el("span", {
        class: "offset",
        text: "bytes " + node.start + "–" + (node.finish - 1)
      }));
    }

    var rows = state.tree.children(node).map(function (pair) {
      return rowFor(RX.labelFor(pair[0], pair[1]), pair[1]);
    });

    var panel = el("div", { class: "panel" }, [
      el("h2", { text: state.tree.label(node) + " - " + RX.typeLabel(node) })
    ]);
    if (rows.length) {
      panel.appendChild(renderRows(rows, false));
    } else {
      panel.appendChild(el("div", { class: "panel-body" }, [
        el("p", { class: "lede", text: "This value has nothing inside it." })
      ]));
    }

    var wrap = document.createDocumentFragment();
    wrap.appendChild(crumbs);
    wrap.appendChild(panel);
    return wrap;
  }

  function renderActionbar() {
    var bar = el("div", { class: "actionbar" }, [
      el("span", { class: "count" }),
      el("button", {
        class: "btn",
        text: "Download patched save",
        onclick: function () {
          try {
            download(RX.applyEdits(state.data, state.tree, enabledEdits()), state.name);
          } catch (e) {
            alert(e.message);
          }
        }
      }),
      el("button", {
        class: "btn link discard-all",
        text: "Discard all",
        onclick: function () { state.edits = new Map(); render(); }
      })
    ]);
    return bar;
  }

  function renderToolbar() {
    var scopeNode = (state.tab === "all" && state.at !== null) ? state.tree.node(state.at) : null;
    var box = el("input", {
      type: "search",
      value: state.query || "",
      placeholder: scopeNode ? "Search inside " + state.tree.label(scopeNode)
                             : "Search names, values, or bytes",
      "aria-label": "Search this save"
    });
    box.addEventListener("keydown", function (e) {
      if (e.key === "Enter") {
        e.preventDefault();
        go({ query: box.value, scope: scopeNode ? scopeNode.start : null });
      }
    });

    return el("div", { class: "toolbar" }, [
      el("div", { class: "search" }, [
        box,
        el("button", {
          class: "btn quiet",
          text: "Search",
          onclick: function () { go({ query: box.value, scope: scopeNode ? scopeNode.start : null }); }
        })
      ]),
      el("button", {
        class: "btn quiet",
        text: "Download original",
        onclick: function () { download(state.data, state.name); }
      }),
      el("button", {
        class: "btn quiet",
        text: "Open a different save",
        onclick: function () { state.data = null; state.tree = null; renderUpload(); }
      })
    ]);
  }

  function render() {
    if (!state.tree) {
      renderUpload();
      return;
    }

    var list = sections();
    if (!state.tab) state.tab = list.length ? list[0].id : "all";

    var stats = state.tree.stats();
    app.innerHTML = "";

    var readout = el("div", { class: "readout" }, [
      el("b", { text: state.name }),
      el("span", { class: "sep", text: "/" }),
      stats.bytes.toLocaleString() + " bytes",
      el("span", { class: "sep", text: "/" }),
      plural(stats.values, "value"),
      el("span", { class: "sep", text: "/" }),
      plural(stats.dumps, "section")
    ]);
    if (stats.trailing) {
      readout.appendChild(el("span", { class: "sep", text: "/" }));
      readout.appendChild(document.createTextNode(stats.trailing + " trailing bytes ignored"));
    }
    app.appendChild(readout);
    app.appendChild(renderToolbar());
    app.appendChild(renderTabs(list));

    if (state.query) {
      app.appendChild(renderSearch());
    } else if (state.tab === "changes") {
      app.appendChild(renderChanges());
    } else if (state.tab === "all") {
      app.appendChild(renderTree());
    } else {
      var section = list.filter(function (s) { return s.id === state.tab; })[0];
      if (!section) {
        state.tab = "all";
        app.appendChild(renderTree());
      } else {
        var rows = sectionRows(section);
        var panel = el("div", { class: "panel" }, [el("h2", { text: section.title })]);
        panel.appendChild(renderRows(rows, false));
        // Only the list-shaped tabs can overflow; the curated field list can't.
        var total = rows.length;
        if (section.kind === "indexed") total = section.node.children.length;
        else if (section.kind === "node") total = state.tree.children(section.node).length;
        if (total > rows.length) {
          panel.appendChild(el("p", { class: "panel-note" }, [
            "Showing the first " + rows.length + ". ",
            el("a", {
              href: "#",
              text: "Browse the full list",
              onclick: function (e) { e.preventDefault(); go({ tab: "all", at: section.node.start }); }
            })
          ]));
        }
        app.appendChild(panel);
      }
    }

    app.appendChild(renderActionbar());
    paintCounts();
  }

  render();
})();
