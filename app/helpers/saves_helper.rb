# frozen_string_literal: true

module SavesHelper
  def offset_tag(offset)
    return "" if offset.negative?

    content_tag(:span, "byte #{offset}", class: "offset")
  end

  def row_state(row)
    row[:pending] ? "row changed" : "row"
  end

  def truncate_value(text, limit = 90)
    text.to_s.length > limit ? "#{text[0, limit]}…" : text.to_s
  end
end
