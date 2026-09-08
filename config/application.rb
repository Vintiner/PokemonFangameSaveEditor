require_relative "boot"

require "rails"
require "action_controller/railtie"
require "action_view/railtie"

Bundler.require(*Rails.groups) if defined?(Bundler)

module RxdataEditor
  class Application < Rails::Application
    # Track whichever Rails this app is installed with, rather than pinning
    # defaults to a version that may be older than the gem in the Gemfile.
    config.load_defaults Rails::VERSION::STRING.to_f

    # No database and no asset pipeline: saves live in a temp directory for the
    # length of an editing session and the stylesheet is inlined in the layout.
    config.eager_load_paths << Rails.root.join("lib")
    config.autoload_paths << Rails.root.join("lib")

    config.hosts << ENV["RENDER_EXTERNAL_HOSTNAME"] if ENV["RENDER_EXTERNAL_HOSTNAME"]
    config.hosts << /\A[a-z0-9-]+\.onrender\.com\z/ if config.respond_to?(:hosts)
  end
end
