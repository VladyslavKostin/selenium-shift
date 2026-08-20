using NUnit.Framework;
using OpenQA.Selenium;
using OpenQA.Selenium.Chrome;
using Shop.Tests.Pages;

namespace Shop.Tests
{
    [TestFixture]
    public class CheckoutTests
    {
        private IWebDriver _driver;
        private LoginPage _login;
        private CartPage _cart;

        [SetUp]
        public void SetUp()
        {
            _driver = new ChromeDriver();
            _driver.Navigate().GoToUrl("https://shop.example.com");
            _login = new LoginPage(_driver);
            _cart = new CartPage(_driver);
        }

        [TearDown]
        public void TearDown()
        {
            _driver.Quit();
        }

        [Test]
        public void UserCanCheckOut()
        {
            _login.Login("buyer@example.com", "hunter2");
            Assert.IsTrue(_login.IsLoggedIn());
            _cart.Checkout();
            Assert.AreEqual("$42.00", _cart.Total());
        }

        [Test]
        public void CartShowsAllRows()
        {
            _login.Login("buyer@example.com", "hunter2");
            Assert.AreEqual(3, _cart.VisibleRowCount());
        }
    }
}
