Rails.application.configure do
  config.eager_load = true
  config.consider_all_requests_local = false
  config.public_file_server.enabled = true

  config.log_level = ENV.fetch("LOG_LEVEL", "info").to_sym
  config.logger = ActiveSupport::Logger.new($stdout)
  config.logger.formatter = ::Logger::Formatter.new

  config.force_ssl = ENV.fetch("FORCE_SSL", "true") == "true"

  config.secret_key_base = ENV.fetch("SECRET_KEY_BASE")
end
