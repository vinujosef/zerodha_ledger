/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      colors: {
        slate: {
          850: "#111827"
        }
      }
    }
  },
  plugins: [],
}
