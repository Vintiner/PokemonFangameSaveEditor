# frozen_string_literal: true

module Rxdata
  # Navigation layer over a scanned file: parents, paths, search.
  # Nodes are addressed by their byte offset, which is unique within a file and
  # stays valid for as long as the uploaded bytes are untouched.
  class Tree
    ROOT_ID = -1
    SEARCH_LIMIT = 200

    attr_reader :scanner, :root

    def initialize(data)
      @data = data
      @scanner = Scanner.new(data).parse
      @root = build_root
      @parents = {}
      @labels = { ROOT_ID => "File", @root.id => "File" }
      index_parents(@root)
    end

    def node(offset)
      offset = offset.to_i
      return @root if offset == ROOT_ID

      @scanner.node_at(offset)
    end

    def label(node)
      @labels[node.id] || Presenter.type_label(node)
    end

    def children(node)
      Presenter.effective(node).children
    end

    def breadcrumbs(node)
      trail = []
      current = node
      while current
        trail.unshift(current)
        parent = @parents[current.id]
        break if parent.nil? || parent.id == current.id

        current = parent
      end
      trail
    end

    # "File / player / party / 0" -- the trail without the value's own name, so
    # a search result can show where it lives next to what it is.
    def path_string(node)
      breadcrumbs(node)[0..-2].map { |ancestor| label(ancestor) }.join(" / ")
    end

    # The same trail as path_string, but as [label, offset] pairs so each step
    # can be a link back into that part of the file.
    def path_parts(node)
      breadcrumbs(node)[0..-2].map { |ancestor| [label(ancestor), ancestor.id] }
    end

    def parent_of(node)
      @parents[node.id]
    end

    # The innermost value whose bytes cover a given offset, which is what
    # someone has in mind when they arrive here from a hex editor.
    def node_containing(offset)
      offset = offset.to_i
      best = nil
      walk(@root) do |node|
        next if node.id == ROOT_ID
        next unless offset >= node.start && offset < node.finish

        best = node if best.nil? || node.byte_length <= best.byte_length
      end
      best
    end

    Query = Struct.new(:kind, :text, :offset, :pattern, keyword_init: true)

    # Three ways of asking: a byte offset, a run of hex bytes, or plain text to
    # match against names and values.
    def self.parse_query(raw)
      text = raw.to_s.strip
      return Query.new(kind: :empty, text: text) if text.empty?

      if (match = text.match(/\A(?:byte|offset|@)\s*[:#]?\s*(\d+)\z/i))
        return Query.new(kind: :offset, text: text, offset: match[1].to_i)
      end

      if (match = text.match(/\A0x([0-9a-f]+)\z/i))
        return Query.new(kind: :offset, text: text, offset: match[1].to_i(16))
      end

      if text.match?(/\A(?:[0-9a-f]{2}[\s,]+)+[0-9a-f]{2}\z/i)
        pattern = text.scan(/[0-9a-f]{2}/i).map { |pair| pair.to_i(16) }.pack("C*")
        return Query.new(kind: :bytes, text: text, pattern: pattern)
      end

      Query.new(kind: :text, text: text)
    end

    # scope limits the search to one branch, so searching from a subpage looks
    # only inside the thing you are already looking at.
    def search(raw, scope: nil, limit: SEARCH_LIMIT)
      query = self.class.parse_query(raw)
      scope ||= @root

      case query.kind
      when :empty then []
      when :offset then Array(node_containing(query.offset)).select { |node| within?(node, scope) }
      when :bytes then byte_matches(query.pattern, scope, limit)
      else text_matches(query.text.downcase, scope, limit)
      end
    end

    def stats
      counts = Hash.new(0)
      walk(@root) { |node| counts[node.kind] += 1 }
      {
        bytes: @data.bytesize,
        dumps: @scanner.dumps.size,
        values: counts.values.sum - (@scanner.dumps.size > 1 ? 1 : 0),
        trailing: @scanner.trailing_bytes.to_i
      }
    end

    private

    def within?(node, scope)
      return true if scope.equal?(@root)

      node.start >= scope.start && node.finish <= scope.finish
    end

    def text_matches(needle, scope, limit)
      results = []
      walk(scope) do |node|
        next if node.equal?(scope)

        label_text = (@labels[node.id] || "").downcase
        results << node if label_text.include?(needle) || value_text(node).downcase.include?(needle)
        throw :done if results.size >= limit
      end
      results
    end

    def byte_matches(pattern, scope, limit)
      results = []
      cursor = scope.equal?(@root) ? 0 : scope.start
      ceiling = scope.equal?(@root) ? @data.bytesize : scope.finish

      while (found = @data.index(pattern, cursor))
        break if found >= ceiling

        node = node_containing(found)
        results << node if node && !results.include?(node)
        break if results.size >= limit

        cursor = found + 1
      end
      results
    end

    def walk(node, &block)
      catch(:done) { walk_inner(node, &block) }
    end

    def walk_inner(node, &block)
      block.call(node)
      node.children.each { |(_, child)| walk_inner(child, &block) }
    end

    def value_text(node)
      target = Presenter.effective(node)
      case target.kind
      when :string then Presenter.text_value(target)
      when :symbol, :symlink then target.value.to_s
      when :int, :float, :bignum then target.value.to_s
      when :object, :userdef, :usermarshal, :struct then target.class_name.to_s
      else ""
      end
    end

    # A single Marshal dump is the common case, but RPG Maker XP wrote saves as
    # several dumps back to back. Wrapping them in one synthetic node lets the
    # rest of the app treat both layouts identically.
    def build_root
      return @scanner.dumps.first if @scanner.dumps.size == 1

      root = Node.new(:root, ROOT_ID)
      root.finish = @data.bytesize
      @scanner.dumps.each_with_index do |dump, i|
        root.children << ["Section #{i + 1}", dump]
      end
      root
    end

    def index_parents(node)
      Presenter.effective(node).children.each do |(name, child)|
        @parents[child.id] = node
        @labels[child.id] = Presenter.label_for(name, child)
        index_parents(child)
      end
    end
  end
end
