# frozen_string_literal: true

class ApplicationController < ActionController::Base
  protect_from_forgery with: :exception

  rescue_from Rxdata::Store::NotFound do |e|
    redirect_to root_path, alert: e.message
  end

  rescue_from Rxdata::ParseError do |e|
    redirect_to root_path, alert: e.message
  end
end
