# frozen_string_literal: true

# Run with: ruby test/scanner_test.rb path/to/save.rxdata
require_relative "../lib/rxdata/scanner"
require_relative "../lib/rxdata/patcher"
require_relative "../lib/rxdata/presenter"
require_relative "../lib/rxdata/tree"

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
  FAIL << "#{name}: #{e.class}: #{e.message.to_s[0, 200]}"
  puts "  FAIL #{name} -- #{e.class}: #{e.message.to_s[0, 200]}"
end

# --- Marshal-compatible loading of saves whose game classes we don't have -----
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
      when %r{undefined class/module ([\w:]+)}
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

def walk(node, &block)
  block.call(node)
  node.children.each { |(_, child)| walk(child, &block) }
end

def find_child(node, label)
  node.children.each { |(name, child)| return child if name == label }
  nil
end

puts "\n== packed integer encoding matches Ruby =="
values = [0, 1, 122, 123, 255, 256, 65_535, 65_536, 2**24, 2**30 - 1,
          -1, -123, -124, -255, -256, -65_536, -(2**30)]
check "pack_long round-trips #{values.size} boundary values" do
  bad = values.reject do |v|
    Rxdata::Codec.integer(v) == Marshal.dump(v).byteslice(2..)
  end
  bad.empty? || "mismatch at #{bad.inspect}"
end

check "oversized integers are refused rather than silently promoted" do
  begin
    Rxdata::Codec.integer(2**30)
    "no error raised"
  rescue Rxdata::EditError
    true
  end
end

puts "\n== synthetic streams =="
sample = { name: "Trainer", level: 42, ratio: 0.75, flags: [true, false, nil],
           nested: { "a" => [1, 2, 3] }, big: 10**20, sym: :PIKACHU }
check "scanner consumes a synthetic dump exactly" do
  bytes = Marshal.dump(sample)
  scanner = Rxdata::Scanner.new(bytes).parse
  scanner.dumps.first.finish == bytes.bytesize || "stopped at #{scanner.dumps.first.finish} of #{bytes.bytesize}"
end

check "scanner reads concatenated dumps the way RPG Maker XP writes them" do
  bytes = Marshal.dump([1, 2]) + Marshal.dump("hello") + Marshal.dump({ a: 1 })
  scanner = Rxdata::Scanner.new(bytes).parse
  scanner.dumps.size == 3 || "found #{scanner.dumps.size} dumps"
end

check "object links resolve to the right shared object" do
  shared = "same"
  bytes = Marshal.dump([shared, shared])
  scanner = Rxdata::Scanner.new(bytes).parse
  array = scanner.dumps.first
  second = array.children[1][1]
  target = scanner.object(second.ref)
  (second.kind == :link && target.kind == :string && target.value == "same") ||
    "link #{second.ref} resolved to #{target&.kind.inspect}"
end

puts "\n== real save file =="
path = ARGV[0] || File.expand_path("../../rx/File_G.rxdata", __dir__)
data = File.binread(path)
scanner = Rxdata::Scanner.new(data).parse
root = scanner.dumps.first

check "whole file is consumed with no leftover bytes" do
  scanner.trailing_bytes.zero? || "#{scanner.trailing_bytes} bytes left over"
end

node_count = 0
walk(root) { node_count += 1 }
puts "  (parsed #{node_count} values across #{scanner.dumps.size} dump(s), #{data.bytesize} bytes)"

check "object links inside a real save resolve to a registered object" do
  links = []
  walk(root) { |node| links << node if node.kind == :link }
  unresolved = links.reject { |node| scanner.object(node.ref) }
  puts "  (#{links.size} back-references in this save)"
  unresolved.empty? || "#{unresolved.size} dangling references"
end

check "re-splicing with no edits reproduces the file byte for byte" do
  Rxdata::Patcher.apply(data, scanner, {}) == data || "bytes changed"
end

variables = find_child(find_child(root, ":variables"), "@data")
check "found the game variables array" do
  !variables.nil? && variables.kind == :array || "not found"
end

var16 = variables.children[16][1]
check "variable 16 reads 34, matching the game" do
  var16.value == 34 || "got #{var16.value.inspect}"
end

check "editing an integer writes through and reloads correctly" do
  patched = Rxdata::Patcher.apply(data, scanner, { var16.id => "77" })
  loaded = marshal_load_tolerant(patched)
  loaded[:variables].instance_variable_get(:@data)[16] == 77 || "reloaded as something else"
end

check "editing an integer only touches the bytes it has to" do
  patched = Rxdata::Patcher.apply(data, scanner, { var16.id => "77" })
  differing = (0...data.bytesize).count { |i| data.getbyte(i) != patched.getbyte(i) }
  (patched.bytesize == data.bytesize && differing == 1) || "#{differing} bytes changed, size #{patched.bytesize}"
end

check "a nil variable can be given a number" do
  nil_var = variables.children.map { |(_, child)| child }.find { |child| child.kind == :nil }
  patched = Rxdata::Patcher.apply(data, scanner, { nil_var.id => "9" })
  index = variables.children.index { |(_, child)| child.equal?(nil_var) }
  marshal_load_tolerant(patched)[:variables].instance_variable_get(:@data)[index] == 9
end

check "a number can be blanked back to nil" do
  patched = Rxdata::Patcher.apply(data, scanner, { var16.id => "nil" })
  marshal_load_tolerant(patched)[:variables].instance_variable_get(:@data)[16].nil?
end

money = find_child(find_child(root, ":player"), "@money")
check "editing money survives a reload" do
  patched = Rxdata::Patcher.apply(data, scanner, { money.id => "999999" })
  marshal_load_tolerant(patched)[:player].instance_variable_get(:@money) == 999_999
end

name_wrapper = find_child(find_child(root, ":player"), "@name")
name_node = name_wrapper.kind == :ivar ? name_wrapper.children.first[1] : name_wrapper
check "editing a string of a different length survives a reload" do
  patched = Rxdata::Patcher.apply(data, scanner, { name_node.id => "Longer Name" })
  reloaded = marshal_load_tolerant(patched)[:player].instance_variable_get(:@name)
  reloaded == "Longer Name" || "got #{reloaded.inspect}"
end

check "editing several values at once survives a reload" do
  edits = { var16.id => "55", money.id => "12345", name_node.id => "Ada" }
  reloaded = marshal_load_tolerant(Rxdata::Patcher.apply(data, scanner, edits))
  reloaded[:variables].instance_variable_get(:@data)[16] == 55 &&
    reloaded[:player].instance_variable_get(:@money) == 12_345 &&
    reloaded[:player].instance_variable_get(:@name) == "Ada"
end

species = nil
walk(root) do |node|
  species = node if species.nil? && node.kind == :symbol && node.role == :value && node.value == "OBSTAGOON"
end
check "editing a symbol value survives a reload" do
  patched = Rxdata::Patcher.apply(data, scanner, { species.id => "PIKACHU" })
  first = marshal_load_tolerant(patched)[:player].instance_variable_get(:@party).first
  first.instance_variable_get(:@species) == :PIKACHU
end

check "class names and instance variable names are not offered as editable" do
  offenders = []
  walk(root) do |node|
    offenders << node if node.kind == :symbol && node.role != :value && Rxdata::Policy.editable?(node)
  end
  offenders.empty? || "#{offenders.size} protected symbols were editable"
end

puts "\n== symbols =="

# Work with the bag entries themselves rather than the first mention of a name
# anywhere in the file, so the tests exercise the item a person would click on.
tree = Rxdata::Tree.new(data)
scanner = tree.scanner
bag_node = tree.children(tree.root).find { |(name, _)| name == ":bag" }&.last
pockets_node = bag_node && tree.children(bag_node).find { |(name, _)| name == "@pockets" }&.last
bag_item_nodes = tree.children(pockets_node).flat_map do |(_, pocket)|
  tree.children(pocket).map { |(_, entry)| tree.children(entry).first&.last }
end.compact

pokeball = bag_item_nodes.find { |node| node.value == "POKEBALL" && node.kind == :symlink }
potion = bag_item_nodes.find { |node| node.value == "POTION" && node.kind == :symbol }

check("this save has both kinds of symbol mention to work with") do
  !pokeball.nil? && !potion.nil? || "did not find both a definition and a back-reference"
end

check("rebuilding every symbol mention with nothing edited reproduces the file") do
  replacements = Rxdata::Patcher.symbol_replacements(scanner, {})
  out = data.b.dup
  replacements.sort_by { |r| -r[:start] }.each { |r| out[r[:start]...r[:finish]] = r[:bytes] }
  out == data || "#{replacements.size} rewritten mentions changed the bytes"
end

def bag_items(save)
  pockets = save[:bag].instance_variable_get(:@pockets)
  pockets = pockets.values if pockets.is_a?(Hash)
  pockets.flatten(1).select { |entry| entry.is_a?(Array) }.map(&:first)
end

check("a back-referenced symbol can be edited") do
  patched = Rxdata::Patcher.apply(data, scanner, { pokeball.id => "MASTERBALL" })
  items = bag_items(marshal_load_tolerant(patched))
  items.include?(:MASTERBALL) || "MASTERBALL not in the bag"
end

check("editing one mention leaves the others alone") do
  before = bag_items(marshal_load_tolerant(data)).count(:POKEBALL)
  patched = Rxdata::Patcher.apply(data, scanner, { pokeball.id => "MASTERBALL" })
  after = bag_items(marshal_load_tolerant(patched)).count(:POKEBALL)
  after == before - 1 || "count went #{before} -> #{after}"
end

check("a symbol definition and a back-reference can be edited together") do
  patched = Rxdata::Patcher.apply(data, scanner,
                                  { pokeball.id => "MASTERBALL", potion.id => "MAXPOTION" })
  items = bag_items(marshal_load_tolerant(patched))
  items.include?(:MASTERBALL) && items.include?(:MAXPOTION) && !items.include?(:POTION) ||
    "got #{items.inspect[0, 120]}"
end

check("the rest of the save survives a symbol edit") do
  patched = Rxdata::Patcher.apply(data, scanner, { pokeball.id => "MASTERBALL" })
  loaded = marshal_load_tolerant(patched)
  loaded[:player].instance_variable_get(:@money) == 206_554 &&
    loaded[:variables].instance_variable_get(:@data)[16] == 34 &&
    loaded[:player].instance_variable_get(:@party).first.instance_variable_get(:@species) == :OBSTAGOON
end

check("species symbols on a party member can be edited") do
  species = nil
  walk(root) do |node|
    species ||= node if %i[symbol symlink].include?(node.kind) && node.role == :value &&
                        node.value == "OBSTAGOON"
  end
  patched = Rxdata::Patcher.apply(data, scanner, { species.id => "PIKACHU" })
  marshal_load_tolerant(patched)[:player].instance_variable_get(:@party)
    .first.instance_variable_get(:@species) == :PIKACHU
end

check("names that Marshal can't hold are refused") do
  refused = ["", "   ", "SUPER POTION", "POTIÓN"].count do |bad|
    begin
      Rxdata::Patcher.apply(data, scanner, { pokeball.id => bad })
      false
    rescue Rxdata::EditError
      true
    end
  end
  refused == 4 || "only #{refused} of 4 were refused"
end

puts "\n#{PASS.size} passed, #{FAIL.size} failed"
FAIL.each { |f| puts "  - #{f}" }
exit(FAIL.empty? ? 0 : 1)
