Rails.application.routes.draw do
  root "saves#new"

  post "saves", to: "saves#create", as: :saves

  scope "saves/:id", constraints: { id: /[A-Za-z0-9_-]{8,32}/ } do
    get "/", to: "saves#show", as: :save
    get "search", to: "saves#search", as: :save_search
    post "edits", to: "saves#update_edits", as: :save_edits
    post "changes", to: "saves#update_changes", as: :save_changes
    post "revert", to: "saves#revert", as: :save_revert
    get "download", to: "saves#download", as: :save_download
    get "original", to: "saves#original", as: :save_original
  end
end
