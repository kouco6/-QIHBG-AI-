import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './app/App'
import { AuthProvider } from './app/AuthProvider'
import './styles/tokens.css'
import './styles/base.css'
import './styles/components.css'

const rootEl = document.getElementById('root')
if (!rootEl) {
  throw new Error('缺少 #root 挂载点')
}

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>,
)
