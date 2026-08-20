using OpenQA.Selenium;

namespace Shop.Tests.Pages
{
    // Interface member: if Login becomes async here, every implementer must
    // change in the same commit or nothing compiles.
    public interface IAuthenticatable
    {
        void Login(string user, string password);
        bool IsLoggedIn();
    }
}
