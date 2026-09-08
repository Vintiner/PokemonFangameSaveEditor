# frozen_string_literal: true

module Rxdata
  # Turns raw scanner nodes into something readable. Kept separate from the
  # scanner so the parsing stays a faithful description of the byte format.
  module Presenter
    ENCODING_IVARS = %w[E encoding].freeze

    module_function

    # A string in a Marshal stream is usually wrapped in a node carrying its
    # encoding. People shouldn't have to see or think about that wrapper, so
    # display and editing both target the string inside it.
    def effective(node)
      return node unless node.kind == :ivar

      inner = node.children.first&.last
      return node if inner.nil?

      extras = node.children.drop(1)
      return inner if inner.kind == :string && extras.all? { |(name, _)| ENCODING_IVARS.include?(name) }

      node
    end

    def editable?(node)
      Policy.editable?(effective(node))
    end

    def type_label(node)
      node = effective(node)
      case node.kind
      when :int then "Number"
      when :float then "Decimal"
      when :string then "Text"
      when :symbol, :symlink then "Name"
      when :true, :false then "Yes/no"
      when :nil then "Empty"
      when :array then "List of #{node.children.size}"
      when :hash then "Table of #{node.children.size}"
      when :object then node.class_name
      when :ivar then node.children.first&.last&.class_name || "Value"
      when :userdef then "#{node.class_name} (raw)"
      when :usermarshal then node.class_name
      when :struct then "#{node.class_name} (struct)"
      when :link then "Same as earlier value"
      when :bignum then "Large number"
      when :class, :module then node.kind.to_s.capitalize
      else node.kind.to_s
      end
    end

    def container?(node)
      node = effective(node)
      !node.children.empty?
    end

    # Short one-line rendering used in listings.
    def summary(node, scanner, budget: 60)
      node = effective(node)
      case node.kind
      when :int, :bignum then node.value.to_s
      when :float then node.value.to_s
      when :string then text_value(node).inspect
      when :symbol, :symlink then ":#{node.value}"
      when :true then "true"
      when :false then "false"
      when :nil then "empty"
      when :array then brief_list(node, scanner, budget)
      when :hash then "#{node.children.size} #{node.children.size == 1 ? 'entry' : 'entries'}"
      when :object, :struct, :usermarshal then "#{node.children.size} fields"
      when :userdef then "#{node.value.to_s.bytesize} bytes of #{node.class_name} data"
      when :link then link_summary(node, scanner)
      else ""
      end
    end

    def brief_list(node, scanner, budget)
      parts = []
      node.children.each do |(_, child)|
        piece = summary(child, scanner, budget: 12)
        break if parts.join(", ").length + piece.length > budget

        parts << piece
      end
      suffix = parts.size < node.children.size ? ", …" : ""
      "[#{parts.join(', ')}#{suffix}]"
    end

    def link_summary(node, scanner)
      target = scanner.object(node.ref)
      return "points to an earlier value" if target.nil?

      "same as #{type_label(target).downcase} at byte #{target.start}"
    end

    def text_value(node)
      node = effective(node)
      return "" unless node.kind == :string

      node.value.dup.force_encoding(Encoding::UTF_8).scrub("?")
    end

    def input_value(node)
      node = effective(node)
      case node.kind
      when :string then text_value(node)
      when :symbol, :symlink then node.value.to_s
      when :nil then ""
      when :true then "true"
      when :false then "false"
      else node.value.to_s
      end
    end

    def label_for(name, node)
      base = name.to_s.sub(/\A@/, "").tr("_", " ")
      base = base.sub(/\A:/, "") if base.start_with?(":")
      base.empty? ? type_label(node) : base
    end

    # A save is a big tree, and most of it is scenery. These are the parts
    # people actually came to change, found by shape rather than by save format
    # version so that both modern and older RPG Maker XP layouts work.
    module Highlights
      module_function

      def sections(scanner)
        sections = []
        trainer = find_object(scanner) { |node| ivar(node, "@money") && ivar(node, "@name") }

        if trainer
          fields = []
          { "@name" => "Name", "@money" => "Money", "@coins" => "Coins",
            "@soot" => "Soot", "@id" => "Trainer ID" }.each do |ivar_name, label|
            child = ivar(trainer, ivar_name)
            fields << [label, child] if child && Presenter.editable?(child)
          end
          badges = ivar(trainer, "@badges")
          sections << { id: "trainer", title: "Trainer", kind: :fields, fields: fields } if fields.any?
          # The curated Trainer list above is guesswork about what people want
          # first. This one is the player object exactly as the game stored it,
          # named after its own class, so nothing is hidden by that guess.
          title = trainer.class_name.to_s.empty? ? "Player" : trainer.class_name
          sections << { id: "player", title: title, kind: :node, node: trainer }
          if badges && badges.kind == :array
            sections << { id: "badges", title: "Badges", kind: :indexed, node: badges, prefix: "Badge" }
          end
        end

        # The bag hangs off the player in some versions and sits at the top
        # level in others, so find it by the shape of what it holds.
        bag = trainer ? ivar(trainer, "@bag") : nil
        bag = nil unless bag && bag.kind == :object
        bag ||= find_object(scanner) { |node| ivar(node, "@pockets") }
        sections << { id: "bag", title: "Bag", kind: :node, node: bag } if bag

        variables = data_array(scanner, "Game_Variables")
        if variables
          sections << { id: "variables", title: "Variables", kind: :indexed, node: variables, prefix: "Variable" }
        end

        switches = data_array(scanner, "Game_Switches")
        if switches
          sections << { id: "switches", title: "Switches", kind: :indexed, node: switches, prefix: "Switch" }
        end

        sections
      end

      def data_array(scanner, class_name)
        owner = find_object(scanner) { |node| node.class_name == class_name }
        return nil unless owner

        array = ivar(owner, "@data")
        array&.kind == :array ? array : nil
      end

      def ivar(node, name)
        node.children.each { |(child_name, child)| return child if child_name == name }
        nil
      end

      def find_object(scanner, &block)
        scanner.dumps.each do |dump|
          found = search(dump, &block)
          return found if found
        end
        nil
      end

      def search(node, &block)
        return node if (node.kind == :object || node.kind == :struct) && block.call(node)

        node.children.each do |(_, child)|
          found = search(child, &block)
          return found if found
        end
        nil
      end
    end
  end
end
