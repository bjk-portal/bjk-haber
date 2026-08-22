// Date display
const dateSpan = document.getElementById('current-date');
if (dateSpan) {
    const options = { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' };
    const today = new Date().toLocaleDateString('tr-TR', options);
    dateSpan.textContent = today;
}

// Mobile menu toggle placeholder
const mobileToggle = document.getElementById('mobile-toggle');
if (mobileToggle) {
    mobileToggle.addEventListener('click', () => {
        alert('Beşiktaş JK Haber Portalı Menüsü');
    });
}
