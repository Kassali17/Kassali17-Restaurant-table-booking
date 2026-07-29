/* Shared editable menu.  Changes are stored in the browser and are shared by
   the home page and admin dashboard on this site. */
const AZ_DEFAULT_MENU = [
  ['Non-Veg','Chicken Biryani',150],['Non-Veg','Mutton Biryani',250],['Non-Veg','Chicken Fried Rice',120],['Non-Veg','Chicken Noodles',120],['Non-Veg','Chicken Manchurian',100],['Non-Veg','Butter Chicken',100],['Non-Veg','Chicken Tikka',100],['Non-Veg','Mutton Chukka',150],
  ['Veg','Veg Biryani',120],['Veg','Veg Fried Rice',100],['Veg','Paneer Fried Rice',100],['Veg','Veg Noodles',100],['Veg','Gobi Manchurian',100],['Veg','Butter Naan',50],['Veg','Paneer Butter Masala',80],
  ['Dessert','Gulab Jamun',60],['Dessert','Rasmalai',80],['Dessert','Chocolate Brownie',100],['Dessert','Vanilla Ice Cream',50],['Dessert','Gajar Ka Halwa',90],
  ['Drinks','Fresh Orange Juice',60],['Drinks','Watermelon Juice',50],['Drinks','Mango Shake',70],['Drinks','Pineapple Juice',60],['Drinks','Lemon Mint Cooler',40]
].map((item, index) => ({ id: `menu-${index + 1}`, category:item[0], name:item[1], price:item[2] }));

function getAzMenu() {
  try {
    const saved = JSON.parse(localStorage.getItem('az_menu_items'));
    return Array.isArray(saved) && saved.length ? saved : AZ_DEFAULT_MENU.map(item => ({ ...item }));
  } catch (_) { return AZ_DEFAULT_MENU.map(item => ({ ...item })); }
}

function saveAzMenu(items) {
  localStorage.setItem('az_menu_items', JSON.stringify(items));
}
