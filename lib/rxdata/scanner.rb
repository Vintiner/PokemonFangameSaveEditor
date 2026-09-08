# frozen_string_literal: true

module Rxdata
  class ParseError < StandardError; end

  # One value in the Marshal stream, with the exact byte span it occupies.
  # The span is what makes surgical editing possible: we never re-serialise the
  # whole save, we splice new bytes over the span of the value being changed.
  class Node
    attr_accessor :kind, :start, :finish, :value, :children,
                  :class_name, :ref, :role, :obj_index, :key_nodes

    def initialize(kind, start)
      @kind = kind
      @start = start
      @children = []
    end

    def byte_length
      finish - start
    end

    def leaf?
      children.empty?
    end

    # Stable identity for the web UI. Byte offsets are unique within a file and
    # stay valid for as long as the underlying bytes are untouched.
    def id
      start
    end
  end

  # Reads a Marshal 4.8 stream without instantiating any Ruby objects, so a save
  # from a game whose classes we don't have still parses completely.
  class Scanner
    attr_reader :dumps, :index, :trailing_bytes, :symbol_refs

    def initialize(data)
      @data = data.b
      @pos = 0
      @index = {}
      @dumps = []
      @objects = []
      @symbols = []
      # Every symbol mention, in stream order, one list per dump. Editing a
      # symbol means rebuilding these, so they are collected as we read.
      @symbol_refs = []
      @current_refs = []
    end

    # RPG Maker XP saves written before Essentials 19 are several Marshal dumps
    # concatenated together, so keep reading until the bytes run out.
    def parse
      while @pos < @data.bytesize && @data.getbyte(@pos) == 4 && @data.getbyte(@pos + 1) == 8
        @symbols = []
        @objects = []
        @current_refs = []
        @symbol_refs << @current_refs
        @pos += 2
        @dumps << read_value
      end

      raise ParseError, "This isn't a Ruby Marshal stream (expected bytes 04 08)." if @dumps.empty?

      @trailing_bytes = @data.bytesize - @pos
      self
    end

    def node_at(offset)
      @index[offset]
    end

    def object(idx)
      @objects[idx]
    end

    private

    def read_value(role: :value)
      start = @pos
      tag = @data.getbyte(@pos)
      raise ParseError, "Ran out of data at byte #{@pos}." if tag.nil?

      @pos += 1
      node = Node.new(:unknown, start)

      case tag
      when 0x30 # 0 -- nil
        node.kind = :nil
      when 0x54 # T
        node.kind = :true
        node.value = true
      when 0x46 # F
        node.kind = :false
        node.value = false
      when 0x69 # i
        node.kind = :int
        node.value = read_long
      when 0x3A # :
        node.kind = :symbol
        node.role = role
        node.value = read_bytes(read_long)
        @symbols << node.value
        @current_refs << node
      when 0x3B # ;
        node.kind = :symlink
        node.role = role
        node.ref = read_long
        node.value = @symbols[node.ref]
        @current_refs << node
      when 0x40 # @
        node.kind = :link
        node.ref = read_long
      when 0x49 # I -- value with instance variables (strings carry encoding this way)
        node.kind = :ivar
        node.children << ["value", read_value]
        read_ivars(node)
      when 0x22 # "
        node.kind = :string
        node.value = read_bytes(read_long)
        register(node)
      when 0x5B # [
        node.kind = :array
        register(node)
        count = read_long
        count.times { |i| node.children << [i.to_s, read_value] }
      when 0x7B, 0x7D # { }
        node.kind = :hash
        register(node)
        node.key_nodes = []
        count = read_long
        count.times do
          key = read_value
          value = read_value
          node.key_nodes << key
          node.children << [key_label(key), value]
        end
        node.children << ["default", read_value] if tag == 0x7D
      when 0x6F # o
        node.kind = :object
        node.class_name = read_class_name
        register(node)
        read_ivars(node)
      when 0x75 # u -- class defines _dump/_load (Table, Color, Tone)
        node.kind = :userdef
        node.class_name = read_class_name
        node.value = read_bytes(read_long)
        register(node)
      when 0x55 # U -- class defines marshal_dump/marshal_load
        node.kind = :usermarshal
        node.class_name = read_class_name
        register(node)
        node.children << ["data", read_value]
      when 0x66 # f
        node.kind = :float
        raw = read_bytes(read_long)
        node.value = parse_float(raw)
        register(node)
      when 0x6C # l
        node.kind = :bignum
        sign = read_bytes(1)
        words = read_long
        digits = read_bytes(words * 2)
        node.value = decode_bignum(sign, digits)
        register(node)
      when 0x63, 0x6D, 0x4D # c m M
        node.kind = tag == 0x63 ? :class : :module
        node.value = read_bytes(read_long)
        register(node)
      when 0x65 # e -- extended by a module
        node.kind = :extended
        node.class_name = read_class_name
        node.children << ["value", read_value]
      when 0x43 # C -- subclass of a core type
        node.kind = :uclass
        node.class_name = read_class_name
        node.children << ["value", read_value]
      when 0x53 # S
        node.kind = :struct
        node.class_name = read_class_name
        register(node)
        read_ivars(node)
      when 0x2F # /
        node.kind = :regexp
        node.value = read_bytes(read_long)
        @pos += 1 # options byte
        register(node)
      when 0x64 # d
        node.kind = :data
        node.class_name = read_class_name
        register(node)
        node.children << ["value", read_value]
      else
        raise ParseError, format("Unknown type byte 0x%02X at offset %d.", tag, start)
      end

      node.finish = @pos
      @index[start] = node
      node
    end

    def read_ivars(node)
      read_long.times do
        name = read_value(role: :ivar_name)
        node.children << [name.value.to_s, read_value]
      end
    end

    def read_class_name
      read_value(role: :class_name).value.to_s
    end

    # Mirrors Ruby's own r_entry ordering. Containers are registered before
    # their contents so that cyclic references resolve to the right index.
    def register(node)
      node.obj_index = @objects.size
      @objects << node
    end

    def read_bytes(count)
      raise ParseError, "Ran out of data at byte #{@pos}." if @pos + count > @data.bytesize

      out = @data.byteslice(@pos, count)
      @pos += count
      out
    end

    def read_long
      c = @data.getbyte(@pos)
      raise ParseError, "Ran out of data at byte #{@pos}." if c.nil?

      @pos += 1
      c -= 256 if c > 127
      return 0 if c.zero?

      if c.positive?
        return c - 5 if c > 4

        n = 0
        c.times { |i| n |= read_bytes(1).getbyte(0) << (8 * i) }
        n
      else
        return c + 5 if c < -4

        n = -1
        (-c).times do |i|
          n &= ~(0xFF << (8 * i))
          n |= read_bytes(1).getbyte(0) << (8 * i)
        end
        n
      end
    end

    def parse_float(raw)
      case raw
      when "inf" then Float::INFINITY
      when "-inf" then -Float::INFINITY
      when "nan" then Float::NAN
      else raw.split("\0").first.to_f
      end
    end

    def key_label(key)
      case key.kind
      when :symbol, :symlink then ":#{key.value}"
      when :string then key.value.dup.force_encoding(Encoding::UTF_8).scrub
      when :int, :float then key.value.to_s
      when :array then "[#{key.children.map { |(_, child)| key_label(child) }.join(', ')}]"
      when :nil then "nil"
      when :true, :false then key.value.to_s
      else "<#{key.kind}>"
      end
    end

    def decode_bignum(sign, digits)
      value = 0
      digits.bytes.each_with_index { |b, i| value |= b << (8 * i) }
      sign == "-" ? -value : value
    end
  end
end
