/** @type {import('tailwindcss').Config} */
export default {
    content: [
        "./index.html",
        "./src/**/*.{js,ts,jsx,tsx}",
    ],
    theme: {
        extend: {
            colors: {
                nexus: {
                    bg: '#121212',
                    text: '#E0E0E0',
                    accent: '#00ADB5',
                    button: '#222831',
                }
            }
        },
    },
    plugins: [],
}
