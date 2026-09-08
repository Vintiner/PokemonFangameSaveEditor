# frozen_string_literal: true

module Rxdata
  class EditError < StandardError; end

  # Writes the handful of value types we allow people to change.
  #
  # Two invariants keep a patched save loadable, and every encoder here obeys
  # them. Marshal refers to repeated symbols and objects by their position in
  # the stream, so a replacement must never add or remove a symbol definition,
  # and never change how many entries land in the object table. That is why a
  # string is written as a bare string (its encoding flag, which lives in the
  # surrounding wrapper, is left alone) and why an integer too large for a
  # Fixnum is refused rather than promoted to a Bignum.
  module Codec
    FIXNUM_MIN = -(2**30)
    FIXNUM_MAX = (2**30) - 1

    module_function

    def pack_long(number)
      return "\x00".b if number.zero?
      return (number + 5).chr.b if number.positive? && number < 123
      return ((number - 5) & 0xFF).chr.b if number.negative? && number > -124

      buffer = +"".b
      value = number
      (1..4).each do |i|
        buffer << (value & 0xFF).chr.b
        value >>= 8
        if value.zero?
          return i.chr.b + buffer
        elsif value == -1
          return ((-i) & 0xFF).chr.b + buffer
        end
      end
      raise EditError, "Number is too large for this save format."
    end

    def integer(value)
      unless value.between?(FIXNUM_MIN, FIXNUM_MAX)
        raise EditError, "Enter a whole number between #{FIXNUM_MIN} and #{FIXNUM_MAX}."
      end

      "i".b + pack_long(value)
    end

    def nil_value
      "0".b
    end

    def boolean(value)
      value ? "T".b : "F".b
    end

    def string(value)
      bytes = value.to_s.dup.force_encoding(Encoding::UTF_8).b
      '"'.b + pack_long(bytes.bytesize) + bytes
    end

    def symbol_name(value)
      name = value.to_s.strip.sub(/\A:/, "")
      raise EditError, "A name can't be empty." if name.empty?
      raise EditError, "A name can't contain spaces." if name.match?(/\s/)
      unless name.ascii_only?
        raise EditError, "Names have to be plain ASCII, like POTION or SUPER_POTION."
      end

      name
    end

    def symbol(name)
      bytes = symbol_name(name).b
      ":".b + pack_long(bytes.bytesize) + bytes
    end

    def symbol_link(index)
      ";".b + pack_long(index)
    end

    # Floats carry no symbols and occupy one object slot either way, so Ruby's
    # own serialiser is safe here and gets the shortest round-trip form right.
    def float(value)
      Marshal.dump(value.to_f).byteslice(2..)
    end
  end

  # Decides what a person is allowed to change about a given node.
  module Policy
    module_function

    def editor_for(node)
      case node.kind
      when :int then { type: :integer }
      when :nil then { type: :integer, blank_is_nil: true }
      when :float then { type: :float }
      when :true, :false then { type: :boolean }
      when :string then { type: :string }
      when :symbol, :symlink then node.role == :value ? { type: :symbol } : nil
      end
    end

    def editable?(node)
      !editor_for(node).nil?
    end
  end

  class Patcher
    SYMBOL_KINDS = %i[symbol symlink].freeze

    # edits: { byte_offset => raw_input_string }
    def self.apply(data, scanner, edits)
      replacements = []
      symbol_edits = {}

      edits.each do |offset, input|
        node = scanner.node_at(offset.to_i)
        raise EditError, "No value lives at byte #{offset}." if node.nil?

        if SYMBOL_KINDS.include?(node.kind)
          symbol_edits[node.id] = Codec.symbol_name(input)
        else
          replacements << { start: node.start, finish: node.finish, bytes: encode(node, input) }
        end
      end

      replacements.concat(symbol_replacements(scanner, symbol_edits)) if symbol_edits.any?

      out = data.b.dup
      # Splice from the end backwards so earlier offsets stay valid even when a
      # replacement is a different length than what it replaced.
      replacements.sort_by { |r| -r[:start] }.each do |r|
        out[r[:start]...r[:finish]] = r[:bytes]
      end
      out
    end

    # Marshal writes a symbol out in full the first time and refers back to it
    # by position afterwards, so a symbol can't be rewritten where it sits: the
    # occurrence you want to change is often just a back-reference, and adding
    # or removing a definition renumbers every reference after it.
    #
    # So rather than patch one mention, rebuild them all. Walking the mentions
    # in order and re-deciding each one -- write it out, or point back at an
    # earlier one -- keeps the numbering right by construction. With nothing
    # edited this reproduces the original bytes exactly, and it means editing
    # one mention changes only that mention, even when others share the name.
    def self.symbol_replacements(scanner, symbol_edits)
      scanner.symbol_refs.flat_map do |mentions|
        table = {}
        mentions.map do |node|
          name = symbol_edits.fetch(node.id, node.value)
          index = table[name]
          if index
            bytes = Codec.symbol_link(index)
          else
            table[name] = table.size
            bytes = Codec.symbol(name)
          end
          { start: node.start, finish: node.finish, bytes: bytes }
        end
      end
    end

    # Whether an entry actually differs from what is in the file. Symbols are
    # compared by name, since their bytes depend on what came before them.
    def self.changed?(node, input, data)
      if SYMBOL_KINDS.include?(node.kind)
        Codec.symbol_name(input) != node.value
      else
        encode(node, input) != data.byteslice(node.start, node.byte_length)
      end
    end

    def self.encode(node, input)
      editor = Policy.editor_for(node)
      raise EditError, "That value can't be edited." if editor.nil?

      input = input.to_s
      case editor[:type]
      when :integer
        return Codec.nil_value if blank?(input) && node.kind == :nil
        return Codec.nil_value if input.strip.casecmp("nil").zero?
        raise EditError, "Enter a whole number, not #{input.strip.inspect}." unless input.strip.match?(/\A-?\d+\z/)

        Codec.integer(Integer(input.strip, 10))
      when :float
        raise EditError, "Enter a number, not #{input.strip.inspect}." unless input.strip.match?(/\A-?\d*\.?\d+(e-?\d+)?\z/i)

        Codec.float(Float(input.strip))
      when :boolean
        Codec.boolean(%w[true 1 on yes].include?(input.strip.downcase))
      when :string
        Codec.string(input)
      when :symbol
        Codec.symbol(input.strip)
      end
    end

    def self.blank?(value)
      value.nil? || value.strip.empty?
    end
  end
end
