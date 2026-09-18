import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './i18n'
import App from './App.jsx'
import { MotionRoot } from './motionUi.jsx'


createRoot(document.getElementById('root')).render(
  <StrictMode>
    {/* One animation system for the app, configured once: reduced-motion
        users are honoured here, and only the features actually used are
        loaded (see src/motionUi.js). */}
    <MotionRoot>
      <App />
    </MotionRoot>
  </StrictMode>,
)
