Rails.application.configure do
  config.cache_classes = false if config.respond_to?(:cache_classes=)
  config.eager_load = false
  config.consider_all_requests_local = true
  config.public_file_server.enabled = true
  config.secret_key_base = "development-only-key-not-used-in-production"
end
