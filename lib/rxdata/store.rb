# frozen_string_literal: true

require "fileutils"
require "json"
require "securerandom"
require "tmpdir"

module Rxdata
  # Holds an uploaded save and its pending edits for the length of one editing
  # session. Deliberately a directory of plain files rather than a database:
  # the app needs no persistence beyond the session, which keeps deployment to
  # a single web service with nothing else attached.
  class Store
    ID_PATTERN = /\A[A-Za-z0-9_-]{8,32}\z/
    MAX_BYTES = 20 * 1024 * 1024
    MAX_AGE_SECONDS = 6 * 60 * 60

    class NotFound < StandardError; end
    class TooLarge < StandardError; end

    class << self
      def root
        @root ||= ENV.fetch("RXDATA_STORE_DIR", File.join(Dir.tmpdir, "rxdata-editor"))
      end

      def create(upload)
        bytes = upload.read
        raise TooLarge, "That file is larger than #{MAX_BYTES / 1024 / 1024} MB." if bytes.bytesize > MAX_BYTES

        id = SecureRandom.urlsafe_base64(12).tr("=", "")[0, 16]
        FileUtils.mkdir_p(dir(id))
        File.binwrite(path(id, "save.bin"), bytes)
        write_json(id, "meta.json", "filename" => sanitize(upload.original_filename),
                                    "created_at" => Time.now.to_i)
        write_json(id, "edits.json", {})
        id
      end

      def data(id)
        File.binread(path(id, "save.bin"))
      rescue Errno::ENOENT
        raise NotFound, "That editing session has expired. Upload the save again."
      end

      def meta(id)
        read_json(id, "meta.json")
      end

      # offset => { "value" => String, "enabled" => Boolean }
      def edits(id)
        read_json(id, "edits.json").transform_values do |entry|
          entry.is_a?(Hash) ? entry : { "value" => entry, "enabled" => true }
        end
      end

      def merge_edits(id, changes)
        current = edits(id)
        changes.each do |offset, value|
          if value.nil?
            current.delete(offset.to_s)
          else
            enabled = current.dig(offset.to_s, "enabled")
            current[offset.to_s] = { "value" => value, "enabled" => enabled.nil? ? true : enabled }
          end
        end
        write_json(id, "edits.json", current)
        current
      end

      def set_enabled(id, flags)
        current = edits(id)
        flags.each do |offset, enabled|
          next unless current.key?(offset.to_s)

          current[offset.to_s]["enabled"] = enabled
        end
        write_json(id, "edits.json", current)
        current
      end

      def clear_edits(id)
        write_json(id, "edits.json", {})
      end

      def exists?(id)
        valid_id?(id) && File.exist?(path(id, "save.bin"))
      end

      def valid_id?(id)
        id.to_s.match?(ID_PATTERN)
      end

      # Called on upload. Cheap enough to run inline and keeps the disk from
      # filling up on a long-running instance.
      def sweep!
        cutoff = Time.now - MAX_AGE_SECONDS
        Dir.glob(File.join(root, "*")).each do |entry|
          FileUtils.rm_rf(entry) if File.directory?(entry) && File.mtime(entry) < cutoff
        end
      rescue SystemCallError
        nil
      end

      private

      def dir(id)
        raise NotFound, "Unknown editing session." unless valid_id?(id)

        File.join(root, id)
      end

      def path(id, name)
        File.join(dir(id), name)
      end

      def read_json(id, name)
        JSON.parse(File.read(path(id, name)))
      rescue Errno::ENOENT, JSON::ParserError
        raise NotFound, "That editing session has expired. Upload the save again."
      end

      def write_json(id, name, value)
        File.write(path(id, name), JSON.dump(value))
      end

      # Keep the name the person recognises -- spaces, accents and all. Only
      # path separators and control characters have to go.
      def sanitize(name)
        base = name.to_s.tr("\\", "/").split("/").last.to_s.strip
        base = base.delete("\u0000-\u001f\u007f")
        base = "save.rxdata" if base.empty?
        base[0, 120]
      end
    end
  end
end
