// Firebase Configuration
const firebaseConfig = {
  apiKey: "AIzaSyA60vo5HrzxBbbxftGmjViMcw7aF9aHn6w",
  authDomain: "payment-verify-c82a1.firebaseapp.com",
  databaseURL: "https://payment-verify-c82a1-default-rtdb.firebaseio.com",
  projectId: "payment-verify-c82a1",
  storageBucket: "payment-verify-c82a1.firebasestorage.app",
  messagingSenderId: "975872906866",
  appId: "1:975872906866:web:542760adf1de66161054eb",
  measurementId: "G-5Q5VQ67PGW"
};

firebase.initializeApp(firebaseConfig);
const db = firebase.database();

let allServices = [];
let categories = new Set(['all']);
let currentCategory = 'all';

// Page Load
window.addEventListener('load', function() {
  setTimeout(function() {
    document.getElementById('pageLoader').classList.add('hidden');
  }, 1200);

  loadServices();
  setupContactForm();
});

// Copyright
document.getElementById("copyright").innerHTML = `&copy; ${new Date().getFullYear()} SMM Panel. All rights reserved.`;

// Load Services from Firebase
function loadServices() {
  db.ref('services').on('value', (snapshot) => {
    allServices = [];
    categories = new Set(['all']);

    snapshot.forEach((child) => {
      const service = { id: child.key, ...child.val() };
      allServices.push(service);
      if (service.category) {
        categories.add(service.category);
      }
    });

    // Update service count
    const serviceCountEl = document.getElementById('serviceCountFooter');
    if (serviceCountEl) serviceCountEl.textContent = allServices.length + '+';

    // Render categories
    renderCategories();

    // Render services
    renderServices(allServices);
  });
}

// Render Category Buttons
function renderCategories() {
  const container = document.getElementById('quickCategories');
  container.innerHTML = '';

  const iconMap = {
    'all': 'fa-th-large',
    'facebook': 'fab fa-facebook',
    'instagram': 'fab fa-instagram',
    'youtube': 'fab fa-youtube',
    'tiktok': 'fab fa-tiktok',
    'twitter': 'fab fa-twitter',
    'telegram': 'fab fa-telegram'
  };

  categories.forEach(cat => {
    const isActive = cat === currentCategory ? 'active' : '';
    const catLower = cat.toLowerCase();
    const icon = iconMap[catLower] || 'fa-tag';
    const label = cat === 'all' ? 'All Services' : cat;

    container.innerHTML += `
      <span class="quick-cat ${isActive}" onclick="filterByCategory('${cat}')">
        <i class="${icon.includes('fab') ? icon : 'fas ' + icon}"></i> ${label}
      </span>
    `;
  });
}

// Filter by Category
function filterByCategory(category) {
  currentCategory = category;
  renderCategories();

  if (category === 'all') {
    renderServices(allServices);
  } else {
    const filtered = allServices.filter(s => s.category === category);
    renderServices(filtered);
  }
}

// Search/Filter Services
function filterServices() {
  const searchTerm = document.getElementById('searchInput').value.toLowerCase().trim();

  if (!searchTerm) {
    filterByCategory(currentCategory);
    return;
  }

  let filtered = allServices.filter(s => {
    const name = (s.name || '').toLowerCase();
    const category = (s.category || '').toLowerCase();
    const desc = (s.description || '').toLowerCase();
    return name.includes(searchTerm) || category.includes(searchTerm) || desc.includes(searchTerm);
  });

  if (currentCategory !== 'all') {
    filtered = filtered.filter(s => s.category === currentCategory);
  }

  renderServices(filtered);
}

// Render Services
function renderServices(services) {
  const container = document.getElementById('serviceList');

  // Hide skeleton loader
  const skeleton = document.getElementById('skeletonLoader');
  if (skeleton) skeleton.remove();

  if (services.length === 0) {
    container.innerHTML = `
      <div class="no-services">
        <i class="fas fa-list"></i>
        <h3>No services found</h3>
        <p>Try a different search term or category</p>
      </div>
    `;
    return;
  }

  container.innerHTML = '';

  const iconMap = {
    'facebook': 'fab fa-facebook',
    'instagram': 'fab fa-instagram',
    'youtube': 'fab fa-youtube',
    'tiktok': 'fab fa-tiktok',
    'twitter': 'fab fa-twitter',
    'telegram': 'fab fa-telegram'
  };

  const colorMap = {
    'facebook': '#1877f2',
    'instagram': '#e4405f',
    'youtube': '#ff0000',
    'tiktok': '#000000',
    'twitter': '#1da1f2',
    'telegram': '#0088cc'
  };

  services.forEach((service, index) => {
    const catLower = (service.category || '').toLowerCase();
    const icon = iconMap[catLower] || 'fas fa-bolt';
    const color = colorMap[catLower] || '#6200ea';

    const serviceCard = `
      <div class="service-card" style="animation-delay: ${index * 0.1}s">
        <div class="service-icon-wrapper" style="background: ${color};">
          <i class="${icon}"></i>
        </div>
        <div class="service-content">
          <span class="service-category">${service.category || 'General'}</span>
          <h3 class="service-name">${service.name}</h3>
          <p class="service-desc">${service.description || 'Premium SMM service'}</p>
          <div class="service-meta">
            <div class="meta-item">
              <span class="meta-label">Price/1K</span>
              <span class="meta-value">৳${service.price || 0}</span>
            </div>
            <div class="meta-item">
              <span class="meta-label">Min</span>
              <span class="meta-value">${service.minOrder || 100}</span>
            </div>
            <div class="meta-item">
              <span class="meta-label">Max</span>
              <span class="meta-value">${service.maxOrder || 10000}</span>
            </div>
          </div>
          <a href="javascript:void(0)" class="order-btn" onclick="goToOrder('${service.id}')">
            <i class="fas fa-shopping-cart"></i> Order Now
          </a>
        </div>
      </div>
    `;

    container.innerHTML += serviceCard;
  });
}

// Navigate to Order Page
function goToOrder(serviceId) {
  const service = allServices.find(s => s.id === serviceId);
  if (!service) return;

  sessionStorage.setItem('currentService', JSON.stringify(service));
  window.location.href = 'invoice.html';
}

// Contact Form
function setupContactForm() {
  const form = document.getElementById('contactForm');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const formData = new FormData(form);
    const data = {};
    formData.forEach((value, key) => data[key] = value);
    data.time = new Date().toLocaleString();

    try {
      await db.ref('messages').push().set(data);

      Swal.fire({
        icon: 'success',
        title: 'Message Sent!',
        text: 'We will get back to you soon.',
        confirmButtonColor: '#6200ea'
      });

      form.reset();
    } catch (err) {
      Swal.fire({
        icon: 'error',
        title: 'Failed to send',
        text: 'Please try again later.',
        confirmButtonColor: '#6200ea'
      });
    }
  });
}

// Mobile Menu Toggle
function toggleMobileMenu() {
  document.getElementById('mobileMenu').classList.toggle('hidden');
}

function closeMobileMenu() {
  document.getElementById('mobileMenu').classList.add('hidden');
}

// Smooth scroll for anchor links
document.querySelectorAll('a[href^="#"]').forEach(anchor => {
  anchor.addEventListener('click', function (e) {
    e.preventDefault();
    const target = document.querySelector(this.getAttribute('href'));
    if (target) {
      target.scrollIntoView({ behavior: 'smooth' });
    }
  });
});
