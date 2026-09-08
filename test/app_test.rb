# frozen_string_literal: true

# Boots the app and drives it through real requests.
#   ruby test/app_test.rb path/to/save.rxdata
#
# The shims directory holds an empty bundler/setup so the app can boot in an
# environment where the gems come from the OS rather than from a Gemfile.lock.
$LOAD_PATH.unshift(File.expand_path("shims", __dir__))

require "tmpdir"
require "tempfile"
require "fileutils"
ENV["RAILS_ENV"] = "development"
ENV["RXDATA_STORE_DIR"] = Dir.mktmpdir("rxdata-test")

require_relative "../config/environment"
require "rack/test"

# The forms carry a CSRF token in the browser; this harness posts directly.
ActionController::Base.allow_forgery_protection = false

SAVE_PATH = ARGV[0] || File.expand_path("../../rx/File_G.rxdata", __dir__)

# Byte offsets of the three faction reputation variables in the sample save.
REP = [15_644, 15_646, 15_648].freeze

PASS = []
FAIL = []

def check(name)
  result = yield
  if result == true
    PASS << name
    puts "  ok   #{name}"
  else
    FAIL << "#{name}: #{result}"
    puts "  FAIL #{name} -- #{result}"
  end
rescue StandardError => e
  FAIL << "#{name}: #{e.class}: #{e.message}"
  puts "  FAIL #{name} -- #{e.class}: #{e.message}"
  puts "        #{e.backtrace.first(4).join("\n        ")}"
end

class Client
  include Rack::Test::Methods

  def app
    Rails.application
  end
end

def define_stub(path)
  parent = Object
  path.split("::").each do |part|
    if parent.const_defined?(part, false)
      parent = parent.const_get(part, false)
    else
      klass = Class.new
      parent.const_set(part, klass)
      parent = klass
    end
  end
end

def marshal_load_tolerant(bytes)
  500.times do
    begin
      return Marshal.load(bytes)
    rescue StandardError => e
      case e.message
      when %r{undefined class/module ([\w:]+)}, /uninitialized constant ([\w:]+)/
        define_stub(Regexp.last_match(1).sub(/::\z/, ""))
      when /class ([\w:]+) needs to have method `_load'/
        Object.const_get(Regexp.last_match(1)).class_eval do
          def self._load(raw)
            allocate.tap { |o| o.instance_variable_set(:@__raw, raw) }
          end

          def _dump(_depth)
            instance_variable_get(:@__raw)
          end
        end
      else
        raise
      end
    end
  end
  raise "gave up loading"
end

def variables_of(bytes)
  marshal_load_tolerant(bytes)[:variables].instance_variable_get(:@data)
end

client = Client.new
# Host authorisation is on, so requests have to arrive with an allowed host.
client.header "Host", "localhost"
original = File.binread(SAVE_PATH)

puts "\n== upload =="
client.get "/"
check("upload page renders") { client.last_response.status == 200 || client.last_response.status }

# A name with spaces, to prove the download keeps it intact.
spaced = File.join(Dir.mktmpdir, "My Save File.rxdata")
FileUtils.cp(SAVE_PATH, spaced)
client.post "/saves", save: Rack::Test::UploadedFile.new(spaced, "application/octet-stream")
check("upload redirects into an editing session") do
  client.last_response.status == 302 || "status #{client.last_response.status}"
end

session_path = client.last_response.location.to_s
id = session_path[%r{/saves/([^/?]+)}, 1]
check("session id looks right") { !id.nil? || "no id in #{session_path.inspect}" }

client.get session_path
body = client.last_response.body
check("browse page renders") { client.last_response.status == 200 || client.last_response.body[0, 300] }
check("readout reports the file size") { body.include?("137,338") || "size line missing" }
check("the original filename with spaces is shown") { body.include?("My Save File.rxdata") || "name mangled" }

puts "\n== tabs =="
{ "Trainer" => "trainer", "Player" => "player", "Bag" => "bag", "Badges" => "badges",
  "Variables" => "variables", "Switches" => "switches", "All data" => "all",
  "Changes" => "changes" }.each do |title, slug|
  check("there is a #{title.inspect} tab") do
    body.include?("tab=#{slug}") && body.include?(title) || "tab missing"
  end
end
check("the first tab is marked as current") { body.include?('aria-current="page"') || "no current tab" }
check("upload-a-different-save is offered") { body.include?("Upload a different save") || "missing" }
check("the unmodified original can be downloaded") { body.include?("Download original") || "missing" }
check("the action bar explains that changes save themselves") do
  body.include?("save as you make them") || "no explanation"
end

client.get "/saves/#{id}", tab: "variables"
variables_body = client.last_response.body
check("the variables tab lists variables") { variables_body.include?("Variable 16") || "no variables" }
check("editable values render as inputs") do
  variables_body.include?(%(name="values[#{REP[0]}]")) || "no input for byte #{REP[0]}"
end
check("locations are shown in decimal and hex") do
  variables_body.include?("byte #{REP[0]}") && variables_body.include?("0x#{REP[0].to_s(16).upcase}") ||
    "offsets missing"
end

puts "\n== the player tab =="
client.get "/saves/#{id}", tab: "player"
player_body = client.last_response.body
check("the player tab lists the object's own fields") do
  %w[party pokedex badges].all? { |field| player_body.include?(">#{field}<") } ||
    "fields missing"
end
check("the player tab is named after the class in the save") do
  player_body.include?("Player") || "not named"
end
check("player fields that hold structures can be browsed into") do
  player_body.include?("?at=") || "no drill-down"
end

puts "\n== the bag tab =="
client.get "/saves/#{id}", tab: "bag"
bag_body = client.last_response.body
check("the bag tab lists what the bag holds") { bag_body.include?(">pockets<") || "no pockets" }
check("the bag's pockets can be browsed into") { bag_body.include?("?at=") || "no drill-down" }

# A bag item is a symbol, and Marshal records repeat symbols as back-references.
# Both kinds have to be editable or the bag is only half usable.
pockets = Rxdata::Tree.new(original)
bag_root = pockets.children(pockets.root).find { |(name, _)| name == ":bag" }&.last
pocket_list = pockets.children(bag_root).find { |(name, _)| name == "@pockets" }&.last
item_nodes = pockets.children(pocket_list).flat_map do |(_, pocket)|
  pockets.children(pocket).map { |(_, entry)| pockets.children(entry).first&.last }
end.compact
back_referenced = item_nodes.find { |node| node.kind == :symlink }
spelled_out = item_nodes.find { |node| node.kind == :symbol }

check("a back-referenced item is offered as editable, not read-only") do
  Rxdata::Policy.editable?(back_referenced) || "still read-only"
end

client.get "/saves/#{id}", at: pockets.parent_of(back_referenced).id
check("a back-referenced item renders as an input") do
  client.last_response.body.include?(%(name="values[#{back_referenced.id}]")) || "no input"
end

client.post "/saves/#{id}/edits", values: { back_referenced.id.to_s => "MASTERBALL" }, tab: "bag"
client.get "/saves/#{id}/download"
swapped = client.last_response.body.b
check("editing a back-referenced item changes it in the downloaded save") do
  bag = marshal_load_tolerant(swapped)[:bag].instance_variable_get(:@pockets)
  bag = bag.values if bag.is_a?(Hash)
  bag.flatten(1).select { |e| e.is_a?(Array) }.map(&:first).include?(:MASTERBALL) ||
    "MASTERBALL missing"
end
check("the other items are untouched by that edit") do
  before = marshal_load_tolerant(original)
  after = marshal_load_tolerant(swapped)
  before[:player].instance_variable_get(:@money) == after[:player].instance_variable_get(:@money) &&
    after[:player].instance_variable_get(:@party).first.instance_variable_get(:@species) == :OBSTAGOON
end
check("typing the same name back is not recorded as a change") do
  client.post "/saves/#{id}/revert", tab: "bag"
  client.post "/saves/#{id}/edits",
              values: { spelled_out.id.to_s => spelled_out.value }, tab: "bag"
  client.follow_redirect!
  client.last_response.body.include?("save as you make them") || "recorded a no-op change"
end
client.post "/saves/#{id}/revert", tab: "bag"

puts "\n== an edit survives leaving the page =="
client.post "/saves/#{id}/edits",
            values: { REP[0].to_s => "41" },
            tab: "player",
            next: "/saves/#{id}?tab=badges"
check("saving with somewhere to go afterwards lands there") do
  client.last_response.location.to_s.end_with?("tab=badges") || client.last_response.location.to_s
end
client.get "/saves/#{id}", tab: "variables"
check("the change made on the way out was kept") do
  client.last_response.body.include?('value="41"') || "change lost"
end
client.post "/saves/#{id}/edits", values: {}, tab: "player", next: "https://example.com/"
check("an off-site destination is ignored") do
  location = client.last_response.location.to_s
  !location.include?("example.com") || "redirected off-site to #{location}"
end
client.post "/saves/#{id}/edits", values: {}, tab: "player", next: "//example.com/"
check("a protocol-relative destination is ignored") do
  location = client.last_response.location.to_s
  !location.include?("example.com") || "redirected off-site to #{location}"
end
client.post "/saves/#{id}/revert", tab: "variables"

puts "\n== downloading the original =="
client.get "/saves/#{id}/original"
check("the original download matches the uploaded bytes") { client.last_response.body.b == original || "differs" }
check("the original download keeps the spaced filename") do
  client.last_response.headers["Content-Disposition"].to_s.include?("My Save File.rxdata") ||
    client.last_response.headers["Content-Disposition"].inspect
end

puts "\n== editing stays where you are =="
client.post "/saves/#{id}/edits", values: { REP[0].to_s => "77" }, tab: "variables"
check("applying a change returns to the same tab") do
  client.last_response.location.to_s.include?("tab=variables") ||
    "went to #{client.last_response.location}"
end

client.follow_redirect!
after_edit = client.last_response.body
check("the pending change is counted") { after_edit.include?("1 change</b> will be applied") || "not counted" }
check("the input shows the pending value") { after_edit.include?('value="77"') || "not repopulated" }
check("the manual apply button is gone from the normal view") do
  !after_edit.sub(%r{<noscript>.*?</noscript>}m, "").include?("Apply changes on this screen") ||
    "apply button still shown"
end
check("there is still a way to apply changes without JavaScript") do
  after_edit.include?("<noscript>") && after_edit.include?("Apply changes on this screen") ||
    "no fallback"
end
check("a successful change shows no empty error box") do
  !after_edit.include?('class="flash alert"') || "an empty alert was rendered"
end
check("the changes tab shows a count") { after_edit.include?('class="pill"') || "no count pill" }

client.post "/saves/#{id}/edits", values: { REP[0].to_s => "banana" }, tab: "variables"
client.follow_redirect!
check("a nonsense number is refused with a message") do
  client.last_response.body.include?("whole number") || "no error shown"
end

puts "\n== the changes tab =="
client.post "/saves/#{id}/edits", values: { REP[1].to_s => "55", REP[2].to_s => "55" }, tab: "variables"
client.get "/saves/#{id}", tab: "changes"
changes_body = client.last_response.body
check("every pending change is listed") do
  REP.all? { |offset| changes_body.include?("byte #{offset}") } || "not all listed"
end
check("each change shows where it lives") do
  changes_body.include?('class="path"') && changes_body.include?(">variables</a>") ||
    "no path shown"
end
check("each change shows old and new values") { changes_body.include?("→") || "no before/after" }

client.post "/saves/#{id}/changes", enabled: { REP[0].to_s => "1", REP[1].to_s => "1" }, tab: "changes"
client.follow_redirect!
check("the changes tab has no manual update button outside noscript") do
  page = client.last_response.body
  !page.sub(%r{<noscript>.*?</noscript>}m, "").include?("Update which changes are included") ||
    "update button still shown"
end
check("holding a change back is reported") do
  client.last_response.body.include?("held back") || "no held-back note"
end

client.get "/saves/#{id}/download"
partial = client.last_response.body.b
check("a held-back change is left out of the download") do
  vars = variables_of(partial)
  [vars[16], vars[17], vars[18]] == [77, 55, 0] || "got #{[vars[16], vars[17], vars[18]].inspect}"
end

client.post "/saves/#{id}/changes", remove: REP[0].to_s, tab: "changes"
client.follow_redirect!
check("removing one change leaves the others alone") do
  body = client.last_response.body
  !body.include?("byte #{REP[0]}") && body.include?("byte #{REP[1]}") || "wrong change removed"
end

puts "\n== download =="
client.post "/saves/#{id}/changes", enabled: { REP[1].to_s => "1", REP[2].to_s => "1" }, tab: "changes"
client.get "/saves/#{id}/download"
patched = client.last_response.body.b
check("the download keeps the original filename") do
  client.last_response.headers["Content-Disposition"].to_s.include?("My Save File.rxdata") ||
    client.last_response.headers["Content-Disposition"].inspect
end
check("the patched save is the same size") { patched.bytesize == original.bytesize || patched.bytesize }
check("only the edited bytes differ") do
  differing = (0...original.bytesize).count { |i| original.getbyte(i) != patched.getbyte(i) }
  differing == 2 || "#{differing} bytes differ"
end
check("the patched save loads with the new values") do
  vars = variables_of(patched)
  [vars[16], vars[17], vars[18]] == [34, 55, 55] || "got #{[vars[16], vars[17], vars[18]].inspect}"
end

puts "\n== search =="
client.get "/saves/#{id}/search", q: "money"
check("search finds a field by name") { client.last_response.body.include?("206554") || "not found" }
check("search results show the path to each match") do
  client.last_response.body.include?('class="path"') || "no paths shown"
end
check("every step of a result's path is a link into that part of the file") do
  spans = client.last_response.body.scan(%r{<span class="path">(.*?)</span>}m)
  links = spans.map { |(inner)| inner.scan(%r{<a href="([^"]+)"[^>]*>([^<]+)</a>}) }
  deepest = links.max_by(&:size).to_a
  deepest.size >= 2 && links.flatten(1).all? { |href, _| href.include?("at=") } ||
    "deepest path had #{deepest.size} links: #{deepest.inspect}"
end
check("clicking a path step opens that part of the file") do
  page = client.last_response.body
  href = page[%r{<span class="path">.*?<a href="([^"]+)"}m, 1]
  client.get CGI.unescapeHTML(href)
  client.last_response.status == 200 || "status #{client.last_response.status}"
end

client.get "/saves/#{id}/search", q: "byte #{REP[0]}"
check("search accepts a byte offset") do
  body = client.last_response.body
  body.include?("1 match") && body.include?(%(name="values[#{REP[0]}]")) || "offset search failed"
end
check("a byte-offset match shows the path to the value") do
  client.last_response.body.include?(">variables</a>") || "no path"
end

client.get "/saves/#{id}/search", q: "0x#{REP[0].to_s(16)}"
check("search accepts a hex offset") { client.last_response.body.include?("1 match") || "hex offset failed" }

client.get "/saves/#{id}/search", q: "69 27 69 f3"
check("search accepts a run of hex bytes") do
  client.last_response.body.include?(%(name="values[#{REP[0]}]")) || "byte pattern search failed"
end

party = nil
tree = Rxdata::Tree.new(original)
tree.children(tree.node(-1)).each { |(name, child)| party = child if name == ":player" }
party_id = party.id
client.get "/saves/#{id}/search", q: "money", scope: party_id
scoped = client.last_response.body
check("a scoped search says what it is searching inside") do
  scoped.include?("Searching inside") || "no scope note"
end
check("a scoped search offers to widen") { scoped.include?("whole file") || "no widen link" }
check("a scoped search returns fewer matches than the whole file") do
  scoped_count = scoped[/(\d+) match/, 1].to_i
  client.get "/saves/#{id}/search", q: "money"
  whole_count = client.last_response.body[/(\d+) match/, 1].to_i
  scoped_count.positive? && scoped_count < whole_count || "scoped #{scoped_count} vs whole #{whole_count}"
end

client.post "/saves/#{id}/edits", values: {}, return_to: "search", q: "money"
check("editing from search returns to the search results") do
  client.last_response.location.to_s.include?("search") || client.last_response.location.to_s
end

puts "\n== discarding =="
client.post "/saves/#{id}/revert", tab: "variables"
check("discarding returns to the tab you were on") do
  client.last_response.location.to_s.include?("tab=variables") || client.last_response.location.to_s
end
client.follow_redirect!
check("discarding empties the pending list") do
  page = client.last_response.body
  !page.include?("will be applied") && page.include?("save as you make them") || "changes survived"
end
client.get "/saves/#{id}/download"
check("after discarding, the download matches the original") do
  client.last_response.body.b == original || "bytes differ"
end

puts "\n== errors =="
Tempfile.create(["junk", ".rxdata"]) do |f|
  f.write("this is not a marshal stream")
  f.flush
  client.post "/saves", save: Rack::Test::UploadedFile.new(f.path, "application/octet-stream")
  client.follow_redirect!
  check("a file that isn't a Marshal stream is refused with an explanation") do
    client.last_response.body.include?("Marshal") || "no explanation"
  end
end

client.get "/saves/doesnotexist12/"
check("an unknown session redirects instead of erroring") { client.last_response.status == 302 || client.last_response.status }

puts "\n#{PASS.size} passed, #{FAIL.size} failed"
FAIL.each { |f| puts "  - #{f}" }
exit(FAIL.empty? ? 0 : 1)
