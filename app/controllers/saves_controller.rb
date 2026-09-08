# frozen_string_literal: true

class SavesController < ApplicationController
  before_action :load_session, except: %i[new create]

  INDEXED_LIMIT = 300

  def new; end

  def create
    upload = params[:save]
    if upload.blank?
      redirect_to root_path, alert: "Choose a save file first." and return
    end

    Rxdata::Store.sweep!
    id = Rxdata::Store.create(upload)

    # Parse once up front so a file that isn't a Marshal stream fails here,
    # with a clear message, rather than halfway through browsing it.
    Rxdata::Tree.new(Rxdata::Store.data(id))

    redirect_to save_path(id)
  rescue Rxdata::Store::TooLarge, Rxdata::ParseError => e
    redirect_to root_path, alert: e.message
  end

  def show
    @tab = params[:at].present? ? "all" : params[:tab].presence
    @tab ||= @tabs.first[:id]

    case @tab
    when "all"
      @node = @tree.node(params[:at] || Rxdata::Tree::ROOT_ID)
      if @node.nil?
        redirect_to save_path(@id), alert: "That value is no longer in view." and return
      end

      @breadcrumbs = @tree.breadcrumbs(@node)
      @rows = @tree.children(@node).map { |(name, child)| row_for(name, child) }
    when "changes"
      @changes = change_rows
    else
      @section = section_rows(@sections.find { |section| section[:id] == @tab })
      redirect_to save_path(@id, tab: "all") and return if @section.nil?
    end
  end

  def search
    @query = params[:q].to_s
    @scope = params[:scope].present? ? @tree.node(params[:scope]) : nil
    @scope = nil if @scope.equal?(@tree.root)
    @results = @tree.search(@query, scope: @scope).map do |node|
      row_for(@tree.label(node), node).merge(path: @tree.path_parts(node))
    end
  end

  def update_edits
    changes = {}
    errors = []

    (params[:values] || {}).each do |offset, value|
      node = @tree.node(offset)
      next if node.nil?

      target = Rxdata::Presenter.effective(node)
      next unless Rxdata::Policy.editable?(target)

      begin
        Rxdata::Patcher.encode(target, value) # rejects anything unwritable
        # Storing only genuine differences keeps the pending list honest.
        changes[target.id.to_s] = Rxdata::Patcher.changed?(target, value, @data) ? value : nil
      rescue Rxdata::EditError => e
        errors << "#{@tree.label(node)}: #{e.message}"
      end
    end

    Rxdata::Store.merge_edits(@id, changes) if changes.any?
    applied = changes.values.compact.size

    redirect_back_to_view(
      notice: errors.empty? && applied.positive? ? "Saved #{applied} #{'change'.pluralize(applied)}." : nil,
      alert: errors.first(3).join(" ")
    )
  end

  # The changes list: include or exclude individual edits, or drop one.
  def update_changes
    if params[:remove].present?
      Rxdata::Store.merge_edits(@id, params[:remove].to_s => nil)
      redirect_back_to_view(notice: "Change removed.") and return
    end

    flags = @edits.keys.to_h { |offset| [offset, (params[:enabled] || {}).key?(offset)] }
    Rxdata::Store.set_enabled(@id, flags)
    included = flags.values.count(true)
    redirect_back_to_view(notice: "#{included} of #{flags.size} #{'change'.pluralize(flags.size)} will be included.")
  end

  def revert
    Rxdata::Store.clear_edits(@id)
    redirect_back_to_view(notice: "All changes discarded.")
  end

  def download
    enabled = @edits.select { |_, entry| entry["enabled"] }.transform_values { |entry| entry["value"] }
    patched = Rxdata::Patcher.apply(@data, @tree.scanner, enabled)
    send_data patched, filename: @meta["filename"], type: "application/octet-stream", disposition: "attachment"
  rescue Rxdata::EditError => e
    redirect_to save_path(@id), alert: e.message
  end

  def original
    send_data @data, filename: @meta["filename"], type: "application/octet-stream", disposition: "attachment"
  end

  private

  def load_session
    @id = params[:id]
    raise Rxdata::Store::NotFound, "Unknown editing session." unless Rxdata::Store.exists?(@id)

    @data = Rxdata::Store.data(@id)
    @tree = Rxdata::Tree.new(@data)
    @edits = Rxdata::Store.edits(@id)
    @meta = Rxdata::Store.meta(@id)
    @sections = Rxdata::Presenter::Highlights.sections(@tree.scanner)
    @tabs = build_tabs
  end

  def build_tabs
    tabs = @sections.map { |section| { id: section[:id], title: section[:title] } }
    tabs << { id: "all", title: "All data" }
    tabs << { id: "changes", title: "Changes", count: @edits.size }
    tabs
  end

  # Rows are built only for the tab being shown; a save has far more in it than
  # any one screen needs.
  def section_rows(section)
    return nil if section.nil?

    case section[:kind]
    when :fields
      rows = section[:fields].map { |(label, node)| row_for(label, node).merge(label: label) }
      section.merge(rows: rows)
    when :indexed
      entries = section[:node].children.first(INDEXED_LIMIT)
      rows = entries.each_with_index.map { |(_, child), i| row_for("#{section[:prefix]} #{i}", child) }
      section.merge(rows: rows, truncated: section[:node].children.size > entries.size)
    when :node
      entries = @tree.children(section[:node]).first(INDEXED_LIMIT)
      rows = entries.map { |(name, child)| row_for(name, child) }
      section.merge(rows: rows, truncated: @tree.children(section[:node]).size > entries.size)
    end
  end

  def change_rows
    @edits.filter_map do |offset, entry|
      node = @tree.node(offset)
      next if node.nil?

      {
        offset: offset.to_i,
        label: @tree.label(node),
        path: @tree.path_parts(node),
        type: Rxdata::Presenter.type_label(node),
        was: Rxdata::Presenter.input_value(node),
        now: entry["value"],
        enabled: entry["enabled"]
      }
    end
  end

  def row_for(name, node)
    target = Rxdata::Presenter.effective(node)
    entry = @edits[target.id.to_s]
    {
      node: node,
      target: target,
      label: Rxdata::Presenter.label_for(name, node),
      type: Rxdata::Presenter.type_label(node),
      summary: Rxdata::Presenter.summary(node, @tree.scanner),
      editable: Rxdata::Policy.editable?(target),
      container: Rxdata::Presenter.container?(node) && !Rxdata::Policy.editable?(target),
      value: entry ? entry["value"] : Rxdata::Presenter.input_value(target),
      pending: entry,
      offset: target.id
    }
  end

  # Every form carries the view it was submitted from, so applying, removing or
  # discarding a change returns to the same screen rather than the top of the
  # file. The layout restores scroll position on top of this.
  def redirect_back_to_view(notice: nil, alert: nil)
    # A change made on the way somewhere else is saved first, then the journey
    # continues, so switching tabs never silently drops what you typed.
    if (onward = safe_next_path(params[:next]))
      redirect_to onward, notice: notice.presence, alert: alert.presence and return
    end

    path = if params[:return_to] == "search"
             save_search_path(@id, q: params[:q], scope: params[:scope].presence)
           else
             save_path(@id, tab: params[:tab].presence, at: params[:at].presence)
           end

    redirect_to path, notice: notice.presence, alert: alert.presence
  end

  # Only same-origin paths, so a crafted "next" can't bounce someone off-site.
  def safe_next_path(value)
    value = value.to_s
    return nil unless value.start_with?("/")
    return nil if value.start_with?("//", "/\\")

    value
  end
end
